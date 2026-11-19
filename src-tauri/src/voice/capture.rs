//! Microphone capture with `cpal`. The stream lives on its own thread (cpal streams are not `Send` on macOS)
//! and delivers 16 kHz mono i16 samples to the recording worker over a channel.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
use serde::Serialize;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::JoinHandle;

use super::wav::SAMPLE_RATE;

#[derive(Serialize, Clone, Debug)]
pub struct DeviceInfo {
    pub name: String,
    pub is_default: bool,
}

/// Everything the recording worker reacts to.
pub enum Msg {
    Samples(Vec<i16>),
    /// The input stream failed (e.g. the microphone was unplugged).
    Error(String),
    Pause,
    Resume,
    Stop,
}

enum Ctl {
    Pause,
    Resume,
    Stop,
}

pub fn list_devices() -> Vec<DeviceInfo> {
    let host = cpal::default_host();
    let default = host.default_input_device().and_then(|d| d.name().ok());
    host.input_devices()
        .map(|it| {
            it.filter_map(|d| d.name().ok())
                .map(|name| DeviceInfo { is_default: Some(&name) == default.as_ref(), name })
                .collect()
        })
        .unwrap_or_default()
}

/// Averages input samples down to 16 kHz.
struct Resampler {
    step: f64,
    pos: f64,
    acc: f64,
    n: u32,
}

impl Resampler {
    fn new(rate: u32) -> Self {
        Self { step: rate as f64 / SAMPLE_RATE as f64, pos: 0.0, acc: 0.0, n: 0 }
    }
    fn push(&mut self, v: f32) -> Option<f32> {
        self.acc += v as f64;
        self.n += 1;
        self.pos += 1.0;
        if self.pos >= self.step {
            let out = (self.acc / self.n as f64) as f32;
            self.acc = 0.0;
            self.n = 0;
            self.pos -= self.step;
            Some(out)
        } else {
            None
        }
    }
}

fn build<T>(device: &cpal::Device, config: &cpal::StreamConfig, tx: Sender<Msg>) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = config.channels.max(1) as usize;
    let mut resampler = Resampler::new(config.sample_rate.0);
    let err_tx = tx.clone();
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                let mut out = Vec::with_capacity(data.len() / channels / 2 + 1);
                for frame in data.chunks(channels) {
                    let mono = frame.iter().map(|s| f32::from_sample(*s)).sum::<f32>() / channels as f32;
                    if let Some(v) = resampler.push(mono) {
                        out.push((v.clamp(-1.0, 1.0) * 32767.0) as i16);
                    }
                }
                if !out.is_empty() {
                    let _ = tx.send(Msg::Samples(out));
                }
            },
            move |e| {
                let _ = err_tx.send(Msg::Error(e.to_string()));
            },
            None,
        )
        .map_err(|e| e.to_string())
}

pub struct Capture {
    ctl: Sender<Ctl>,
    thread: Option<JoinHandle<()>>,
    pub device_name: String,
}

impl Capture {
    /// Opens the chosen input device (or the default) and starts streaming into `tx`.
    pub fn start(device: Option<&str>, tx: Sender<Msg>) -> Result<Capture, String> {
        let wanted = device.map(str::to_owned);
        let err_tx = tx.clone();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<String, String>>();
        let (ctl_tx, ctl_rx): (Sender<Ctl>, Receiver<Ctl>) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            // Opens the microphone and starts it. Called at the start and again on every resume, because a paused
            // recording must not hold the microphone: dropping the stream is what releases it (and clears the
            // system's "microphone in use" indicator).
            let open = move || -> Result<(cpal::Stream, String), String> {
                let host = cpal::default_host();
                let dev = match &wanted {
                    Some(name) => host
                        .input_devices()
                        .map_err(|e| e.to_string())?
                        .find(|d| d.name().ok().as_deref() == Some(name))
                        .ok_or_else(|| format!("Microphone \"{name}\" is not available."))?,
                    None => host.default_input_device().ok_or("No microphone found.")?,
                };
                let name = dev.name().unwrap_or_else(|_| "Microphone".into());
                let supported = dev.default_input_config().map_err(|e| e.to_string())?;
                let config: cpal::StreamConfig = supported.clone().into();
                let stream = match supported.sample_format() {
                    SampleFormat::F32 => build::<f32>(&dev, &config, tx.clone())?,
                    SampleFormat::I16 => build::<i16>(&dev, &config, tx.clone())?,
                    SampleFormat::U16 => build::<u16>(&dev, &config, tx.clone())?,
                    other => return Err(format!("Unsupported microphone format: {other:?}")),
                };
                stream.play().map_err(|e| e.to_string())?;
                Ok((stream, name))
            };
            match open() {
                Ok((first, name)) => {
                    let _ = ready_tx.send(Ok(name));
                    let mut stream = Some(first);
                    while let Ok(c) = ctl_rx.recv() {
                        match c {
                            // Release the microphone while paused.
                            Ctl::Pause => stream = None,
                            // Always open a fresh stream: this also recovers from an unplugged or changed device.
                            Ctl::Resume => {
                                stream = None;
                                match open() {
                                    Ok((s, _)) => stream = Some(s),
                                    Err(e) => {
                                        let _ = err_tx.send(Msg::Error(e));
                                    }
                                }
                            }
                            Ctl::Stop => break,
                        }
                    }
                    drop(stream);
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                }
            }
        });
        match ready_rx.recv().map_err(|_| "Audio thread failed to start".to_string())? {
            Ok(device_name) => Ok(Capture { ctl: ctl_tx, thread: Some(thread), device_name }),
            Err(e) => {
                let _ = thread.join();
                Err(e)
            }
        }
    }

    pub fn pause(&self) {
        let _ = self.ctl.send(Ctl::Pause);
    }
    pub fn resume(&self) {
        let _ = self.ctl.send(Ctl::Resume);
    }
    pub fn stop(mut self) {
        let _ = self.ctl.send(Ctl::Stop);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampler_outputs_one_third_for_48k() {
        let mut r = Resampler::new(48_000);
        let n = (0..4800).filter_map(|_| r.push(0.5)).count();
        assert_eq!(n, 1600);
    }

    #[test]
    fn resampler_passes_16k_through() {
        let mut r = Resampler::new(16_000);
        assert_eq!((0..100).filter_map(|_| r.push(0.1)).count(), 100);
    }
}
