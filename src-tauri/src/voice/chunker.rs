//! Cuts the continuous 16 kHz stream into chunks for transcription, preferably at a pause in speech.
//! Pure logic (no audio device), so it is fully unit-tested.

use super::wav::SAMPLE_RATE;

const FRAME: usize = (SAMPLE_RATE as usize) / 50; // 20 ms
const MIN_CHUNK: usize = SAMPLE_RATE as usize * 4; // do not cut before 4 s...
const MAX_CHUNK: usize = SAMPLE_RATE as usize * 15; // ...and always cut by 15 s
const SILENCE_CUT: usize = SAMPLE_RATE as usize * 6 / 10; // 0.6 s of quiet = a natural boundary
/// RMS (0..1) below which a frame counts as silence.
pub const SILENCE_RMS: f32 = 0.012;

#[derive(Debug, Clone, PartialEq)]
pub struct Chunk {
    pub index: u32,
    /// Position on the *active* recording timeline (paused time excluded).
    pub start_ms: u64,
    pub end_ms: u64,
    /// How much of the chunk contains sound; the UI skips near-silent chunks.
    pub voiced_ms: u64,
    pub samples: Vec<i16>,
}

pub fn rms(frame: &[i16]) -> f32 {
    if frame.is_empty() {
        return 0.0;
    }
    let sum: f64 = frame.iter().map(|&s| (s as f64 / 32768.0).powi(2)).sum();
    (sum / frame.len() as f64).sqrt() as f32
}

pub struct Chunker {
    pending: Vec<i16>,
    chunk: Vec<i16>,
    chunk_start: u64, // samples
    total: u64,       // samples accepted so far
    silence_run: usize,
    voiced_frames: u64,
    next_index: u32,
}

impl Chunker {
    pub fn new() -> Self {
        Self { pending: vec![], chunk: vec![], chunk_start: 0, total: 0, silence_run: 0, voiced_frames: 0, next_index: 0 }
    }

    /// Active recording time in milliseconds.
    pub fn active_ms(&self) -> u64 {
        (self.total + self.pending.len() as u64) * 1000 / SAMPLE_RATE as u64
    }

    pub fn push(&mut self, pcm: &[i16]) -> Vec<Chunk> {
        self.pending.extend_from_slice(pcm);
        let mut out = vec![];
        while self.pending.len() >= FRAME {
            let frame: Vec<i16> = self.pending.drain(..FRAME).collect();
            let quiet = rms(&frame) < SILENCE_RMS;
            self.total += FRAME as u64;
            self.chunk.extend_from_slice(&frame);
            if quiet {
                self.silence_run += FRAME;
            } else {
                self.silence_run = 0;
                self.voiced_frames += 1;
            }
            let len = self.chunk.len();
            if len >= MAX_CHUNK || (len >= MIN_CHUNK && self.silence_run >= SILENCE_CUT) {
                out.extend(self.cut());
            }
        }
        out
    }

    /// Ends the current chunk (on pause/stop). Leftover samples shorter than a frame are included.
    pub fn flush(&mut self) -> Option<Chunk> {
        if !self.pending.is_empty() {
            let rest = std::mem::take(&mut self.pending);
            self.total += rest.len() as u64;
            self.chunk.extend_from_slice(&rest);
        }
        self.cut()
    }

    fn cut(&mut self) -> Option<Chunk> {
        if self.chunk.is_empty() {
            return None;
        }
        let samples = std::mem::take(&mut self.chunk);
        let start = self.chunk_start;
        self.chunk_start = self.total;
        let c = Chunk {
            index: self.next_index,
            start_ms: start * 1000 / SAMPLE_RATE as u64,
            end_ms: self.total * 1000 / SAMPLE_RATE as u64,
            voiced_ms: self.voiced_frames * 20,
            samples,
        };
        self.next_index += 1;
        self.silence_run = 0;
        self.voiced_frames = 0;
        Some(c)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(ms: usize) -> Vec<i16> {
        (0..SAMPLE_RATE as usize * ms / 1000).map(|i| if i % 2 == 0 { 8000 } else { -8000 }).collect()
    }
    fn quiet(ms: usize) -> Vec<i16> {
        vec![0; SAMPLE_RATE as usize * ms / 1000]
    }

    #[test]
    fn cuts_at_a_pause_after_the_minimum_length() {
        let mut c = Chunker::new();
        let mut out = c.push(&tone(5000));
        assert!(out.is_empty()); // speech, no pause yet
        out.extend(c.push(&quiet(700)));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].start_ms, 0);
        assert!(out[0].voiced_ms >= 4900 && out[0].voiced_ms <= 5000);
    }

    #[test]
    fn does_not_cut_a_short_pause_early() {
        let mut c = Chunker::new();
        let mut out = c.push(&tone(1500));
        out.extend(c.push(&quiet(700)));
        assert!(out.is_empty()); // under the 4 s minimum
    }

    #[test]
    fn forces_a_cut_at_the_maximum_length() {
        let mut c = Chunker::new();
        let out = c.push(&tone(16_000));
        assert_eq!(out.len(), 1);
        assert!(out[0].end_ms >= 14_900 && out[0].end_ms <= 15_100);
    }

    #[test]
    fn flush_returns_the_tail_and_indices_increase() {
        let mut c = Chunker::new();
        c.push(&tone(5000));
        c.push(&quiet(700));
        c.push(&tone(1000));
        let tail = c.flush().unwrap();
        assert_eq!(tail.index, 1);
        assert!(tail.start_ms >= 5600);
        assert!(c.flush().is_none());
    }

    #[test]
    fn silent_chunks_report_no_voice() {
        let mut c = Chunker::new();
        c.push(&quiet(3000));
        let ch = c.flush().unwrap();
        assert_eq!(ch.voiced_ms, 0);
    }
}
