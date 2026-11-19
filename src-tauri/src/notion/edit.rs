//! Turns "this text became that text" into one targeted Notion `update_content` edit.
//!
//! Notion's search-and-replace edit needs an `old_str` that matches exactly one place in the page. We cut the
//! unchanged start and end off both texts, then widen the changed middle with surrounding text until it is unique.
//! That way only the changed part of the page is touched, never the whole page.

#[derive(Debug, PartialEq)]
pub struct Edit {
    pub old_str: String,
    pub new_str: String,
}

const STEP: usize = 40;

fn common_prefix_len(a: &str, b: &str) -> usize {
    let mut n = 0;
    for ((i, ca), cb) in a.char_indices().zip(b.chars()) {
        if ca != cb {
            return i;
        }
        n = i + ca.len_utf8();
    }
    n
}

fn common_suffix_len(a: &str, b: &str) -> usize {
    let mut n = 0;
    for (ca, cb) in a.chars().rev().zip(b.chars().rev()) {
        if ca != cb {
            break;
        }
        n += ca.len_utf8();
    }
    n
}

fn floor_boundary(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_boundary(s: &str, mut i: usize) -> usize {
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// `None` when nothing changed. `Err` when the change cannot be expressed safely.
pub fn single_edit(old: &str, new: &str) -> Result<Option<Edit>, String> {
    if old == new {
        return Ok(None);
    }
    if old.trim().is_empty() {
        return Err("The Notion page is empty, so there is nothing to anchor the edit to. Add some text in Notion first.".into());
    }
    let mut pre = common_prefix_len(old, new);
    let mut suf = common_suffix_len(&old[pre..], &new[pre..]);
    // prefix and suffix must not overlap in either text
    suf = suf.min(old.len() - pre).min(new.len() - pre);
    let (mut before, mut after) = (0usize, 0usize); // extra context taken from the unchanged ends
    loop {
        let start = floor_boundary(old, pre.saturating_sub(before));
        let end = ceil_boundary(old, (old.len() - suf + after).min(old.len()));
        let old_str = &old[start..end];
        if !old_str.is_empty() && old.matches(old_str).count() == 1 {
            let nstart = floor_boundary(new, pre.saturating_sub(before));
            let nend = ceil_boundary(new, (new.len() - suf + after).min(new.len()));
            return finish(old_str, &new[nstart..nend]);
        }
        let can_before = pre.saturating_sub(before) > 0;
        let can_after = old.len() - suf + after < old.len();
        if !can_before && !can_after {
            // the whole document is the edit, and it is still not unique (cannot happen for a non-empty old)
            return Err("This change cannot be sent as a targeted edit.".into());
        }
        if can_before {
            before += STEP;
        }
        if can_after {
            after += STEP;
        }
        pre = pre.min(old.len());
        suf = suf.min(old.len());
    }
}

fn finish(old_str: &str, new_str: &str) -> Result<Option<Edit>, String> {
    if old_str.contains("<unknown") || new_str.contains("<unknown") {
        return Err("This change touches a block Markdown cannot show (an <unknown> tag). Edit that part in Notion.".into());
    }
    Ok(Some(Edit { old_str: old_str.to_string(), new_str: new_str.to_string() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Applying the edit to the old text must give exactly the new text, and old_str must be unique.
    fn check(old: &str, new: &str) -> Edit {
        let e = single_edit(old, new).unwrap().expect("a change");
        assert_eq!(old.matches(&e.old_str).count(), 1, "old_str must be unique: {:?}", e.old_str);
        assert_eq!(old.replacen(&e.old_str, &e.new_str, 1), new);
        e
    }

    #[test]
    fn no_change_is_no_edit() {
        assert_eq!(single_edit("# a\n", "# a\n").unwrap(), None);
    }

    #[test]
    fn a_small_change_sends_only_a_small_piece() {
        let old = "# Plan\n\n- [ ] write docs\n- [ ] ship it\n\nNotes: later\n";
        let new = "# Plan\n\n- [x] write docs\n- [ ] ship it\n\nNotes: later\n";
        let e = check(old, new);
        assert!(e.old_str.len() < old.len());
        assert!(e.old_str.contains("[ ] write"));
    }

    #[test]
    fn widens_the_edit_until_it_is_unique() {
        let old = "- [ ] task\n- [ ] task\n- [ ] task\n";
        let new = "- [ ] task\n- [x] task\n- [ ] task\n";
        check(old, new);
    }

    #[test]
    fn handles_pure_insertions_and_deletions() {
        check("# A\n\nline one\n\nline three\n", "# A\n\nline one\n\nline two\n\nline three\n");
        check("# A\n\nline one\n\nline two\n\nline three\n", "# A\n\nline one\n\nline three\n");
        check("abc", "abcdef");
        check("abcdef", "abc");
        check("x", "");
        assert!(single_edit("", "y").unwrap_err().contains("empty"));
    }

    #[test]
    fn works_with_non_ascii_text() {
        check("Café — résumé\n\nnaïve ✅ done\n", "Café — résumé\n\nnaïve ❌ not done\n");
        check("日本語のメモ\n日本語のメモ\n", "日本語のメモ\n日本語のノート\n");
    }

    #[test]
    fn refuses_to_touch_unknown_blocks() {
        let old = "# T\n\n<unknown url=\"https://x\" alt=\"form\"/>\n\ntext\n";
        let new = "# T\n\n<unknown url=\"https://y\" alt=\"form\"/>\n\ntext\n";
        assert!(single_edit(old, new).unwrap_err().contains("<unknown>"));
        // a change elsewhere in a page that has one is fine
        check(old, "# T\n\n<unknown url=\"https://x\" alt=\"form\"/>\n\ntext changed\n");
    }

    #[test]
    fn many_random_edits_always_round_trip() {
        let base: String = (0..30).map(|i| format!("## S{}\n\n- [ ] item {} of {}\n\n", i % 5, i % 7, i % 3)).collect();
        for k in 0..60usize {
            let mut new = base.clone();
            let at = (k * 37) % new.len();
            let at = floor_boundary(&new, at);
            new.insert_str(at, if k % 2 == 0 { "X" } else { "é\n" });
            if k % 3 == 0 {
                let del = floor_boundary(&new, (k * 53) % new.len());
                let end = ceil_boundary(&new, (del + 5).min(new.len()));
                new.replace_range(del..end, "");
            }
            if new != base {
                check(&base, &new);
            }
        }
    }
}
