//! Safe external-link flow: only a small allowlist of URL schemes may be opened.

pub fn is_safe_external_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    ["http://", "https://", "mailto:"].iter().any(|p| lower.starts_with(p))
        && !lower.chars().any(|c| c.is_control())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_web_and_mail() {
        assert!(is_safe_external_url("https://example.com/a?b=1"));
        assert!(is_safe_external_url("HTTP://example.com"));
        assert!(is_safe_external_url("mailto:a@b.co"));
    }

    #[test]
    fn rejects_dangerous_schemes() {
        for u in ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "ftp://x", "", "/relative", "https://a\nb"] {
            assert!(!is_safe_external_url(u), "{u}");
        }
    }
}
