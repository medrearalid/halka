use std::{mem::ManuallyDrop, ptr, slice};

use anyhow::{Context, Result, bail, ensure};
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_RATIONAL, DXGI_SAMPLE_DESC};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::Variant::VARIANT;
use windows::core::{GUID, Interface};

const MAX_PENDING: usize = 3;

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Mode {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate: u32,
}

impl Mode {
    pub fn candidates(size: SizeInt32, refresh: u32, preset: &str) -> Result<Vec<Self>> {
        ensure!(
            size.Width >= 2 && size.Height >= 2,
            "Kaynağın boyutu geçersiz."
        );
        let (width, height, fps, bitrate): (u32, u32, u32, u32) = match preset {
            "smooth" => (1280, 720, 60, 3_500_000),
            "balanced" => (1920, 1080, 30, 4_500_000),
            "sharp" => (1920, 1080, 60, 8_000_000),
            "maximum" => (size.Width as u32, size.Height as u32, refresh, 0),
            _ => bail!("Bilinmeyen yayın kalitesi."),
        };
        let target_fps = fps.min(refresh).max(1);
        let width = width.min(size.Width as u32);
        let height = height.min(size.Height as u32);
        let fit_width = (u64::from(height) * size.Width as u64 / size.Height as u64) as u32;
        let fit_height = (u64::from(width) * size.Height as u64 / size.Width as u64) as u32;
        let (width, height) = (width.min(fit_width), height.min(fit_height));
        let target_pixels = u64::from((width & !1).max(2)) * u64::from((height & !1).max(2));
        let mut modes = Vec::new();
        let mut push = |w: u32, h: u32, fps: u32| {
            let (width, height) = ((w & !1).max(2), (h & !1).max(2));
            let scaled = |base: u32, base_w: u32, base_h: u32, base_fps: u32| {
                (u64::from(base) * u64::from(width) * u64::from(height) * u64::from(fps)
                    / (u64::from(base_w) * u64::from(base_h) * u64::from(base_fps)))
                .clamp(600_000, 80_000_000) as u32
            };
            let bitrate = if bitrate == 0 {
                scaled(8_000_000, 1920, 1080, 60)
            } else {
                (u64::from(bitrate) * u64::from(width) * u64::from(height) * u64::from(fps)
                    / (target_pixels * u64::from(target_fps)))
                .clamp(350_000, u64::from(bitrate)) as u32
            };
            let mode = Self {
                width,
                height,
                fps,
                bitrate,
            };
            if !modes.contains(&mode) {
                modes.push(mode);
            }
        };
        for fps in [target_fps, 120, 90, 60, 45, 30] {
            if fps <= target_fps {
                push(width, height, fps);
            }
        }
        for scale in [3, 2, 1] {
            push(width * scale / 4, height * scale / 4, target_fps.min(30));
        }
        Ok(modes)
    }
}

pub struct Device {
    pub raw: ID3D11Device,
    context: ID3D11DeviceContext,
    video: ID3D11VideoDevice,
    video_context: ID3D11VideoContext,
    manager: IMFDXGIDeviceManager,
}

impl Device {
    pub fn new() -> Result<Self> {
        let mut raw = None;
        let mut context = None;
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                Default::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut raw),
                None,
                Some(&mut context),
            )?;
            let raw = raw.context("D3D11 aygıtı yok")?;
            let context = context.context("D3D11 bağlamı yok")?;
            let _ = context
                .cast::<ID3D11Multithread>()?
                .SetMultithreadProtected(true);
            let mut token = 0;
            let mut manager = None;
            MFCreateDXGIDeviceManager(&mut token, &mut manager)?;
            let manager = manager.context("DXGI yöneticisi yok")?;
            manager.ResetDevice(&raw, token)?;
            Ok(Self {
                video: raw.cast()?,
                video_context: context.cast()?,
                raw,
                context,
                manager,
            })
        }
    }

    fn texture(&self, description: &D3D11_TEXTURE2D_DESC) -> Result<ID3D11Texture2D> {
        let mut texture = None;
        unsafe {
            self.raw
                .CreateTexture2D(description, None, Some(&mut texture))?
        };
        texture.context("Video yüzeyi oluşturulamadı")
    }

    pub fn save_frame(
        &self,
        from: &ID3D11Texture2D,
        saved: &mut Option<ID3D11Texture2D>,
    ) -> Result<()> {
        if saved.is_none() {
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            unsafe { from.GetDesc(&mut desc) };
            desc.MiscFlags = 0;
            desc.BindFlags = 0;
            *saved = Some(self.texture(&desc)?);
        }
        unsafe { self.context.CopyResource(saved.as_ref().unwrap(), from) };
        Ok(())
    }
}

struct Converter<'a> {
    device: &'a Device,
    enumeration: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    desc: D3D11_TEXTURE2D_DESC,
    staging: Option<ID3D11Texture2D>,
}

impl<'a> Converter<'a> {
    fn new(device: &'a Device, input: SizeInt32, mode: Mode, gpu: bool) -> Result<Self> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: mode.width,
            Height: mode.height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_NV12,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
            ..Default::default()
        };
        let frame_rate = DXGI_RATIONAL {
            Numerator: mode.fps,
            Denominator: 1,
        };
        let content = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: frame_rate,
            OutputFrameRate: frame_rate,
            InputWidth: input.Width as u32,
            InputHeight: input.Height as u32,
            OutputWidth: mode.width,
            OutputHeight: mode.height,
            Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
        };
        let enumeration = unsafe { device.video.CreateVideoProcessorEnumerator(&content)? };
        let processor = unsafe { device.video.CreateVideoProcessor(&enumeration, 0)? };
        let source_rect = RECT {
            right: input.Width,
            bottom: input.Height,
            ..Default::default()
        };
        let dest_rect = RECT {
            right: mode.width as i32,
            bottom: mode.height as i32,
            ..Default::default()
        };
        unsafe {
            device
                .video_context
                .VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
            device.video_context.VideoProcessorSetStreamSourceRect(
                &processor,
                0,
                true,
                Some(&source_rect),
            );
            device.video_context.VideoProcessorSetStreamDestRect(
                &processor,
                0,
                true,
                Some(&dest_rect),
            );
            device.video_context.VideoProcessorSetOutputTargetRect(
                &processor,
                true,
                Some(&dest_rect),
            );
        }
        let staging = if gpu {
            None
        } else {
            Some(device.texture(&D3D11_TEXTURE2D_DESC {
                Usage: D3D11_USAGE_STAGING,
                BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                ..desc
            })?)
        };
        Ok(Self {
            device,
            enumeration,
            processor,
            desc,
            staging,
        })
    }

    fn convert(&self, texture: &ID3D11Texture2D) -> Result<IMFMediaBuffer> {
        // A fresh surface lets the hardware MFT hold samples without overwriting queued input.
        let output = self.device.texture(&self.desc)?;
        unsafe {
            let mut input_view = None;
            self.device.video.CreateVideoProcessorInputView(
                texture,
                &self.enumeration,
                &D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                    ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                    ..Default::default()
                },
                Some(&mut input_view),
            )?;
            let mut output_view = None;
            self.device.video.CreateVideoProcessorOutputView(
                &output,
                &self.enumeration,
                &D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                    ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                    ..Default::default()
                },
                Some(&mut output_view),
            )?;
            let output_view = output_view.context("Video çıkış görünümü yok")?;
            let mut stream = D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                pInputSurface: ManuallyDrop::new(input_view),
                ..Default::default()
            };
            let result = self.device.video_context.VideoProcessorBlt(
                &self.processor,
                &output_view,
                0,
                slice::from_ref(&stream),
            );
            ManuallyDrop::drop(&mut stream.pInputSurface);
            result?;
            let rows = self.desc.Height as usize * 3 / 2;
            let width = self.desc.Width as usize;
            let length = (rows * width) as u32;
            if let Some(staging) = &self.staging {
                let buffer = MFCreateMemoryBuffer(length)?;
                let mut dest = ptr::null_mut();
                let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                self.device.context.CopyResource(staging, &output);
                self.device
                    .context
                    .Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
                let lock = buffer.Lock(&mut dest, None, None);
                if lock.is_ok() {
                    for row in 0..rows {
                        ptr::copy_nonoverlapping(
                            mapped
                                .pData
                                .cast::<u8>()
                                .add(row * mapped.RowPitch as usize),
                            dest.add(row * width),
                            width,
                        );
                    }
                }
                self.device.context.Unmap(staging, 0);
                lock?;
                buffer.Unlock()?;
                buffer.SetCurrentLength(length)?;
                Ok(buffer)
            } else {
                let buffer = MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, &output, 0, false)?;
                let buffer_2d: IMF2DBuffer = buffer.cast()?;
                buffer.SetCurrentLength(buffer_2d.GetContiguousLength()?)?;
                Ok(buffer)
            }
        }
    }
}

pub struct Chunk {
    pub data: Vec<u8>,
    pub timestamp: i64,
    pub key: bool,
    pub codec: Option<String>,
}

pub struct Encoder<'a> {
    transform: IMFTransform,
    events: Option<IMFMediaEventGenerator>,
    controls: Option<ICodecAPI>,
    converter: Converter<'a>,
    output_id: u32,
    input_id: u32,
    input_tokens: usize,
    in_flight: usize,
    headers: Vec<u8>,
    length_size: usize,
    pub mode: Mode,
}

fn media_type(subtype: &GUID, mode: Mode) -> windows::core::Result<IMFMediaType> {
    unsafe {
        let media = MFCreateMediaType()?;
        media.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        media.SetGUID(&MF_MT_SUBTYPE, subtype)?;
        media.SetUINT64(
            &MF_MT_FRAME_SIZE,
            u64::from(mode.width) << 32 | u64::from(mode.height),
        )?;
        media.SetUINT64(&MF_MT_FRAME_RATE, u64::from(mode.fps) << 32 | 1)?;
        media.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1 << 32) | 1)?;
        media.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        Ok(media)
    }
}

fn activations(flags: MFT_ENUM_FLAG) -> windows::core::Result<Vec<IMFActivate>> {
    let input = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_NV12,
    };
    let output = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_H264,
    };
    let mut pointer = ptr::null_mut();
    let mut count = 0;
    unsafe {
        MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            flags | MFT_ENUM_FLAG_SORTANDFILTER,
            Some(&input),
            Some(&output),
            &mut pointer,
            &mut count,
        )?;
        let mut list = Vec::new();
        for index in 0..count as usize {
            if let Some(activation) = ptr::read(pointer.add(index)) {
                list.push(activation);
            }
        }
        CoTaskMemFree(Some(pointer.cast()));
        Ok(list)
    }
}

impl<'a> Encoder<'a> {
    pub fn select(
        device: &'a Device,
        size: SizeInt32,
        modes: &[Mode],
        start: usize,
    ) -> Result<(usize, Self)> {
        let mut error = None;
        for (index, mode) in modes.iter().copied().enumerate().skip(start) {
            match Self::new(device, size, mode, mode.bitrate) {
                Ok(encoder) => return Ok((index, encoder)),
                Err(last) => error = Some(last),
            }
        }
        Err(error.unwrap_or_else(|| anyhow::anyhow!("Yayın modu yok")))
            .context("Ekran yayını için H.264 kodlayıcısı başlatılamadı")
    }

    pub fn new(device: &'a Device, size: SizeInt32, mode: Mode, bitrate: u32) -> Result<Self> {
        let mut error = None;
        for (flags, gpu) in [
            (MFT_ENUM_FLAG_HARDWARE, true),
            (MFT_ENUM_FLAG_SYNCMFT, false),
        ] {
            for activate in activations(flags)? {
                match Self::open(device, size, mode, bitrate, gpu, &activate) {
                    Ok(encoder) => return Ok(encoder),
                    Err(last) => {
                        error = Some(last);
                        unsafe {
                            let _ = activate.ShutdownObject();
                        }
                    }
                }
            }
        }
        Err(error.unwrap_or_else(|| anyhow::anyhow!("H.264 kodlayıcısı bulunamadı")))
    }

    fn open(
        device: &'a Device,
        size: SizeInt32,
        mode: Mode,
        bitrate: u32,
        gpu: bool,
        activate: &IMFActivate,
    ) -> Result<Self> {
        unsafe {
            let transform: IMFTransform = activate.ActivateObject()?;
            let attributes = transform.GetAttributes()?;
            let events = if attributes.GetUINT32(&MF_TRANSFORM_ASYNC).unwrap_or(0) != 0 {
                attributes.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)?;
                Some(transform.cast()?)
            } else {
                None
            };
            let _ = attributes.SetUINT32(&MF_LOW_LATENCY, 1);
            if gpu {
                ensure!(
                    attributes.GetUINT32(&MF_SA_D3D11_AWARE).unwrap_or(0) != 0,
                    "Kodlayıcı D3D11 desteklemiyor"
                );
                transform.ProcessMessage(
                    MFT_MESSAGE_SET_D3D_MANAGER,
                    device.manager.as_raw() as usize,
                )?;
            }
            let controls = transform.cast::<ICodecAPI>().ok();
            if let Some(api) = &controls {
                let _ = api.SetValue(&CODECAPI_AVLowLatencyMode, &VARIANT::from(true));
                let _ = api.SetValue(&CODECAPI_AVEncMPVDefaultBPictureCount, &VARIANT::from(0u32));
                let _ = api.SetValue(&CODECAPI_AVEncMPVGOPSize, &VARIANT::from(mode.fps * 2));
            }
            let mut input = [0];
            let mut output = [0];
            if let Err(err) = transform.GetStreamIDs(&mut input, &mut output) {
                if err.code() != windows::Win32::Foundation::E_NOTIMPL {
                    return Err(err.into());
                }
            }
            let out = media_type(&MFVideoFormat_H264, mode)?;
            out.SetUINT32(&MF_MT_AVG_BITRATE, bitrate)?;
            out.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)?;
            if transform.SetOutputType(output[0], &out, 0).is_err() {
                out.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Main.0 as u32)?;
                transform.SetOutputType(output[0], &out, 0)?;
            }
            transform.SetInputType(input[0], &media_type(&MFVideoFormat_NV12, mode)?, 0)?;
            let converter = Converter::new(device, size, mode, gpu)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
            let mut encoder = Self {
                transform,
                events,
                controls,
                converter,
                input_id: input[0],
                output_id: output[0],
                input_tokens: 0,
                in_flight: 0,
                headers: Vec::new(),
                length_size: 4,
                mode,
            };
            encoder.read_headers();
            Ok(encoder)
        }
    }

    pub fn accepts_input(&self) -> bool {
        self.in_flight < MAX_PENDING && (self.events.is_none() || self.input_tokens > 0)
    }

    pub fn pending(&self) -> bool {
        self.in_flight > 0
    }

    pub fn set_rate(&self, bitrate: u32) -> bool {
        self.controls.as_ref().is_some_and(|api| unsafe {
            api.SetValue(&CODECAPI_AVEncCommonMeanBitRate, &VARIANT::from(bitrate))
                .is_ok()
        })
    }

    pub fn submit(&mut self, texture: &ID3D11Texture2D, timestamp: i64, key: bool) -> Result<()> {
        unsafe {
            let sample = MFCreateSample()?;
            sample.AddBuffer(&self.converter.convert(texture)?)?;
            sample.SetSampleTime(timestamp)?;
            sample.SetSampleDuration(10_000_000 / i64::from(self.mode.fps))?;
            if key && let Some(api) = &self.controls {
                let _ = api.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &VARIANT::from(1u32));
            }
            self.transform.ProcessInput(self.input_id, &sample, 0)?;
            self.input_tokens = self.input_tokens.saturating_sub(1);
            self.in_flight += 1;
        }
        Ok(())
    }

    pub fn output(&mut self) -> Result<Vec<Chunk>> {
        let mut chunks = Vec::new();
        if let Some(events) = self.events.clone() {
            loop {
                let event = match unsafe { events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
                    Err(error) if error.code() == MF_E_NO_EVENTS_AVAILABLE => break,
                    other => other?,
                };
                unsafe { event.GetStatus()?.ok()? };
                match unsafe { event.GetType()? } as i32 {
                    kind if kind == METransformNeedInput.0 => self.input_tokens += 1,
                    kind if kind == METransformHaveOutput.0 => {
                        if let Some(chunk) = self.read_sample()? {
                            chunks.push(chunk);
                        }
                    }
                    _ => {}
                }
            }
        } else if self.in_flight > 0 {
            while let Some(chunk) = self.read_sample()? {
                chunks.push(chunk);
            }
        }
        Ok(chunks)
    }

    fn read_headers(&mut self) {
        unsafe {
            let data = self
                .transform
                .GetOutputCurrentType(self.output_id)
                .ok()
                .and_then(|ty| {
                    let mut data =
                        vec![0; ty.GetBlobSize(&MF_MT_MPEG_SEQUENCE_HEADER).ok()? as usize];
                    ty.GetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &mut data, None)
                        .ok()?;
                    Some(data)
                });
            if let Some(data) = data {
                if let Some((headers, length_size)) = avcc_headers(&data) {
                    self.headers = headers;
                    self.length_size = length_size;
                } else if data.starts_with(&[0, 0, 1]) || data.starts_with(&[0, 0, 0, 1]) {
                    self.headers = data;
                }
            }
        }
    }

    fn read_sample(&mut self) -> Result<Option<Chunk>> {
        unsafe {
            let mut sample = None;
            let info = self.transform.GetOutputStreamInfo(self.output_id)?;
            if info.dwFlags
                & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0)
                    as u32
                == 0
            {
                let buffer = MFCreateAlignedMemoryBuffer(
                    info.cbSize.max(4096),
                    info.cbAlignment.saturating_sub(1),
                )?;
                let output = MFCreateSample()?;
                output.AddBuffer(&buffer)?;
                sample = Some(output);
            }
            let mut output = MFT_OUTPUT_DATA_BUFFER {
                dwStreamID: self.output_id,
                pSample: ManuallyDrop::new(sample),
                ..Default::default()
            };
            let result = self
                .transform
                .ProcessOutput(0, slice::from_mut(&mut output), &mut 0);
            let sample = ManuallyDrop::take(&mut output.pSample);
            ManuallyDrop::drop(&mut output.pEvents);
            if let Err(error) = result {
                if error.code() == MF_E_TRANSFORM_NEED_MORE_INPUT {
                    return Ok(None);
                }
                if error.code() == MF_E_TRANSFORM_STREAM_CHANGE {
                    let media = self.transform.GetOutputAvailableType(self.output_id, 0)?;
                    self.transform.SetOutputType(self.output_id, &media, 0)?;
                    self.read_headers();
                    return self.read_sample();
                }
                return Err(error.into());
            }
            self.in_flight = self.in_flight.saturating_sub(1);
            let sample = sample.context("Kodlayıcı boş çıktı üretti")?;
            let timestamp = sample.GetSampleTime()?;
            let buffer = sample.ConvertToContiguousBuffer()?;
            let mut bytes = ptr::null_mut();
            let mut length = 0;
            buffer.Lock(&mut bytes, None, Some(&mut length))?;
            let data = if length == 0 {
                Vec::new()
            } else {
                slice::from_raw_parts(bytes, length as usize).to_vec()
            };
            buffer.Unlock()?;
            let mut data = annex_b(data, self.length_size).context("Geçersiz H.264 örneği")?;
            let nals = nal_units(&data);
            let key = nals.iter().any(|nal| nal[0] & 31 == 5);
            if key {
                let sps = nals.iter().copied().find(|nal| nal[0] & 31 == 7);
                let pps = nals.iter().copied().find(|nal| nal[0] & 31 == 8);
                if let (Some(sps), Some(pps)) = (sps, pps) {
                    self.headers.clear();
                    append_nal(&mut self.headers, sps);
                    append_nal(&mut self.headers, pps);
                } else {
                    self.read_headers();
                    let mut with_headers = self.headers.clone();
                    with_headers.append(&mut data);
                    data = with_headers;
                }
            }
            let codec = key
                .then(|| {
                    nal_units(&data)
                        .into_iter()
                        .find(|nal| nal.len() >= 4 && nal[0] & 31 == 7)
                        .map(|sps| format!("avc1.{:02X}{:02X}{:02X}", sps[1], sps[2], sps[3]))
                })
                .flatten();
            Ok(Some(Chunk {
                data,
                timestamp,
                key,
                codec,
            }))
        }
    }
}

impl Drop for Encoder<'_> {
    fn drop(&mut self) {
        unsafe {
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
            let _ = self
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
        }
    }
}

fn append_nal(out: &mut Vec<u8>, nal: &[u8]) {
    out.extend_from_slice(&[0, 0, 0, 1]);
    out.extend_from_slice(nal);
}

fn avcc_headers(data: &[u8]) -> Option<(Vec<u8>, usize)> {
    if data.len() < 7 || data[0] != 1 {
        return None;
    }
    let length_size = usize::from(data[4] & 3) + 1;
    let mut count = usize::from(data[5] & 31);
    let mut tail = &data[6..];
    let mut out = Vec::new();
    for set in 0..2 {
        if set == 1 {
            count = usize::from(*tail.first()?);
            tail = &tail[1..];
        }
        for _ in 0..count {
            let length = u16::from_be_bytes(tail.get(..2)?.try_into().ok()?) as usize;
            append_nal(&mut out, tail.get(2..2 + length)?);
            tail = &tail[2 + length..];
        }
    }
    Some((out, length_size))
}

fn annex_b(data: Vec<u8>, length_size: usize) -> Option<Vec<u8>> {
    if data.starts_with(&[0, 0, 1]) || data.starts_with(&[0, 0, 0, 1]) {
        return Some(data);
    }
    let mut remaining = data.as_slice();
    let mut out = Vec::new();
    while !remaining.is_empty() {
        let length = remaining
            .get(..length_size)?
            .iter()
            .fold(0usize, |n, byte| n * 256 + usize::from(*byte));
        append_nal(
            &mut out,
            remaining.get(length_size..length_size.checked_add(length)?)?,
        );
        remaining = &remaining[length_size + length..];
    }
    Some(out)
}

fn nal_units(data: &[u8]) -> Vec<&[u8]> {
    let mut units = Vec::new();
    let mut start = None;
    for (index, prefix) in data.windows(3).enumerate() {
        if prefix == [0, 0, 1] {
            let end = if index > 0 && data[index - 1] == 0 {
                index - 1
            } else {
                index
            };
            if let Some(start) = start
                && start < end
            {
                units.push(&data[start..end]);
            }
            start = Some(index + 3);
        }
    }
    if let Some(start) = start
        && start < data.len()
    {
        units.push(&data[start..]);
    }
    units
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maximum_uses_the_source_aspect_ratio_and_refresh_rate() {
        let size = SizeInt32 {
            Width: 3440,
            Height: 1440,
        };
        let modes = Mode::candidates(size, 144, "maximum").unwrap();
        assert_eq!(
            (modes[0].width, modes[0].height, modes[0].fps),
            (3440, 1440, 144)
        );
        assert!(
            modes
                .iter()
                .all(|mode| mode.width <= 3440 && mode.height <= 1440 && mode.fps <= 144)
        );
        assert!(
            modes
                .windows(2)
                .all(|pair| pair[1].bitrate <= pair[0].bitrate)
        );
    }

    #[test]
    #[ignore = "requires a Windows desktop with a D3D11 video device and H.264 encoder"]
    fn gpu_encodes_a_native_annex_b_keyframe() -> Result<()> {
        use std::time::{Duration, Instant};
        use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;

        let _runtime = super::super::Runtime::media()?;
        let device = Device::new()?;
        let size = SizeInt32 {
            Width: 1920,
            Height: 1080,
        };
        let input = device.texture(&D3D11_TEXTURE2D_DESC {
            Width: size.Width as u32,
            Height: size.Height as u32,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            ..Default::default()
        })?;
        let modes = Mode::candidates(size, 144, "maximum")?;
        let (_, mut encoder) = Encoder::select(&device, size, &modes, 0)?;
        println!(
            "{}×{} / {} FPS, hardware={}",
            encoder.mode.width,
            encoder.mode.height,
            encoder.mode.fps,
            encoder.converter.staging.is_none()
        );
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut timestamp = 0;
        while Instant::now() < deadline {
            if let Some(key) = encoder.output()?.into_iter().find(|chunk| chunk.key) {
                assert!(
                    key.codec
                        .as_deref()
                        .is_some_and(|codec| codec.starts_with("avc1."))
                );
                let units = nal_units(&key.data);
                assert!(units.iter().any(|nal| nal[0] & 31 == 7));
                assert!(units.iter().any(|nal| nal[0] & 31 == 8));
                return Ok(());
            }
            if encoder.accepts_input() {
                encoder.submit(&input, timestamp, timestamp == 0)?;
                timestamp += 10_000_000 / i64::from(encoder.mode.fps);
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        bail!("Zamanında H.264 anahtar karesi alınamadı")
    }
}
