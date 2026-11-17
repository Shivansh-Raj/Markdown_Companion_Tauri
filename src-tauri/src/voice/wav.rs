//! Minimal incremental 16 kHz mono 16-bit PCM WAV writer, safe against crashes.
//!
//! The header is written up front with a placeholder length, samples are appended as they arrive, and the
//! header is patched on `finish`. If the app dies mid-recording `repair` fixes the header from the file size,
//! so the audio captured so far is never lost.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

pub const SAMPLE_RATE: u32 = 16_000;
const HEADER_LEN: u64 = 44;

fn header(data_len: u32) -> [u8; 44] {
    let mut h = [0u8; 44];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + data_len).to_le_bytes());
    h[8..12].copy_from_slice(b"WAVE");
    h[12..16].copy_from_slice(b"fmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM
    h[22..24].copy_from_slice(&1u16.to_le_bytes()); // mono
    h[24..28].copy_from_slice(&SAMPLE_RATE.to_le_bytes());
    h[28..32].copy_from_slice(&(SAMPLE_RATE * 2).to_le_bytes()); // byte rate
    h[32..34].copy_from_slice(&2u16.to_le_bytes()); // block align
    h[34..36].copy_from_slice(&16u16.to_le_bytes()); // bits
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data_len.to_le_bytes());
    h
}

/// A complete WAV file in memory (used for chunks that are sent to the transcriber).
pub fn encode(samples: &[i16]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + samples.len() * 2);
    out.extend_from_slice(&header(data_len));
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

pub struct WavWriter {
    file: File,
    data_len: u64,
}

impl WavWriter {
    pub fn create(path: &Path) -> std::io::Result<Self> {
        let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
        file.write_all(&header(0))?;
        Ok(Self { file, data_len: 0 })
    }

    pub fn write(&mut self, samples: &[i16]) -> std::io::Result<()> {
        let mut buf = Vec::with_capacity(samples.len() * 2);
        for s in samples {
            buf.extend_from_slice(&s.to_le_bytes());
        }
        self.file.write_all(&buf)?;
        self.data_len += buf.len() as u64;
        Ok(())
    }

    pub fn finish(mut self) -> std::io::Result<()> {
        patch(&mut self.file, self.data_len)
    }
}

fn patch(file: &mut File, data_len: u64) -> std::io::Result<()> {
    let n = data_len.min(u32::MAX as u64) as u32;
    file.seek(SeekFrom::Start(0))?;
    file.write_all(&header(n))?;
    file.flush()
}

/// Fixes the header of a WAV left behind by a crash. Returns the recovered duration in milliseconds.
pub fn repair(path: &Path) -> std::io::Result<u64> {
    let mut file = OpenOptions::new().read(true).write(true).open(path)?;
    let len = file.metadata()?.len();
    let data = len.saturating_sub(HEADER_LEN) & !1; // whole samples only
    let mut head = [0u8; 4];
    file.read_exact(&mut head)?;
    patch(&mut file, data)?;
    Ok(data / 2 * 1000 / SAMPLE_RATE as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("mdc-wav-{}-{name}", std::process::id()));
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn writes_valid_header() {
        let p = tmp("ok.wav");
        let mut w = WavWriter::create(&p).unwrap();
        w.write(&[1, -2, 3, 4]).unwrap();
        w.finish().unwrap();
        let b = std::fs::read(&p).unwrap();
        assert_eq!(&b[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(b[40..44].try_into().unwrap()), 8);
        assert_eq!(b.len(), 44 + 8);
        std::fs::remove_file(p).ok();
    }

    #[test]
    fn repairs_a_truncated_recording() {
        let p = tmp("crash.wav");
        let mut w = WavWriter::create(&p).unwrap();
        w.write(&vec![5i16; 16_000]).unwrap(); // 1 second, never finished
        drop(w);
        assert_eq!(u32::from_le_bytes(std::fs::read(&p).unwrap()[40..44].try_into().unwrap()), 0);
        assert_eq!(repair(&p).unwrap(), 1000);
        let b = std::fs::read(&p).unwrap();
        assert_eq!(u32::from_le_bytes(b[40..44].try_into().unwrap()), 32_000);
        std::fs::remove_file(p).ok();
    }

    #[test]
    fn encode_matches_writer_layout() {
        let b = encode(&[7, 8]);
        assert_eq!(b.len(), 48);
        assert_eq!(u32::from_le_bytes(b[40..44].try_into().unwrap()), 4);
    }
}
