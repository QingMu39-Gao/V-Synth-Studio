use gpui_kit::component::Disableable as _;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::group_box::{GroupBox, GroupBoxVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::{ActiveTheme as _, Icon, Theme, ThemeMode, TitleBar, h_flex, v_flex};
use gpui_kit::*;

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use gpui_webview::WebView;

use crate::config::{Config, ThemePreference};
use crate::formats::{self, Format};
use crate::i18n::{self, Language, Strings};
use crate::jobs::JobCenter;
use crate::pages::Page;
use crate::resources::{Group, Item, Resources};
use crate::services::announce::{self, Announcement};
use crate::services::audio::{self, AudioFormat, AudioInfo, AudioOperation};
use crate::services::bili::{self, Page as VideoPage, ParsedVideo};
use crate::services::dependencies::{self, Id as DependencyId};
use crate::services::jobs::{JobOutcome, JobSnapshot, JobStatus};
use crate::services::libresvip::{self, ProjectInfo};
use crate::services::lyrics::{self, SearchResult, SongDetail};
use crate::services::media_server::MediaServer;
use crate::services::midi::{self, Device as MidiDevice, Options as MidiOptions};
use crate::services::svsep::{self, Stems};
use crate::services::update::{self, UpdateInfo};
use crate::tools::ToolStatus;

const WEBVIEW_DEMO: &str = include_str!("webview_demo.html");

const SIDEBAR_WIDTH: f32 = 228.0;

const ALL_DEPENDENCIES: [DependencyId; 6] = [
    DependencyId::LibreSvip,
    DependencyId::Ffmpeg,
    DependencyId::YtDlp,
    DependencyId::Python,
    DependencyId::UvrModel,
    DependencyId::GameModel,
];

pub struct AppInputs {
    pub output: Entity<InputState>,
    pub download: Entity<InputState>,
    pub ext: Entity<InputState>,
    pub resource_search: Entity<InputState>,
    pub video_url: Entity<InputState>,
    pub lyrics_query: Entity<InputState>,
    pub lyrics_editor: Entity<TextareaState>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AudioOp {
    Convert,
    Extract,
    Pitch,
    Speed,
    Trim,
    Loudness,
}

impl AudioOp {
    const ALL: [Self; 6] = [
        Self::Convert,
        Self::Extract,
        Self::Pitch,
        Self::Speed,
        Self::Trim,
        Self::Loudness,
    ];

    fn label(self, s: &Strings) -> &'static str {
        match self {
            Self::Convert => s.audio_convert,
            Self::Extract => s.audio_extract,
            Self::Pitch => s.audio_pitch,
            Self::Speed => s.audio_speed,
            Self::Trim => s.audio_trim,
            Self::Loudness => s.audio_loudness,
        }
    }

    fn suffix(self) -> &'static str {
        match self {
            Self::Convert => "converted",
            Self::Extract => "audio",
            Self::Pitch => "pitch",
            Self::Speed => "speed",
            Self::Trim => "trim",
            Self::Loudness => "loudness",
        }
    }
}

pub struct VSynthApp {
    page: Page,
    config: Config,
    notice: Option<String>,
    tools: Option<ToolStatus>,
    scanning_tools: bool,
    output_input: Entity<InputState>,
    download_input: Entity<InputState>,
    ext_input: Entity<InputState>,
    resources: Resources,
    resource_error: Option<String>,
    resource_search: Entity<InputState>,
    resource_group: Option<String>,
    webview: Option<Entity<WebView>>,
    webview_error: Option<String>,
    webview_source: Option<String>,
    pv_ready: bool,
    pv_status: Option<String>,
    pv_pending_lyrics: Option<String>,
    pv_injected: Option<String>,
    pv_export_dir: Option<PathBuf>,
    job_center: Entity<JobCenter>,
    tool_job: Option<u64>,
    dependency_job: Option<(DependencyId, u64)>,
    convert_inputs: Vec<PathBuf>,
    convert_format: &'static Format,
    convert_preview: Option<(PathBuf, ProjectInfo)>,
    convert_preview_job: Option<u64>,
    convert_job: Option<u64>,
    convert_notice: Option<String>,
    audio_input: Option<PathBuf>,
    audio_info: Option<AudioInfo>,
    audio_peaks: Vec<f32>,
    audio_selection: Option<(f32, f32)>,
    audio_drag: Option<f32>,
    audio_load_job: Option<u64>,
    audio_run_job: Option<u64>,
    audio_notice: Option<String>,
    audio_operation: AudioOp,
    audio_format: AudioFormat,
    audio_semitones: i32,
    audio_ratio: f32,
    audio_lufs: i32,
    waveform_bounds: Rc<RefCell<Option<Bounds<Pixels>>>>,
    video_url_input: Entity<InputState>,
    video_info: Option<ParsedVideo>,
    video_quality: Option<u32>,
    video_parse_job: Option<u64>,
    video_page_job: Option<u64>,
    video_download_job: Option<u64>,
    video_notice: Option<String>,
    video_output: Option<PathBuf>,
    video_webview: Option<Entity<WebView>>,
    video_webview_error: Option<String>,
    media_server: Option<MediaServer>,
    lyrics_query: Entity<InputState>,
    lyrics_editor: Entity<TextareaState>,
    lyrics_results: Vec<SearchResult>,
    lyrics_song: Option<SongDetail>,
    lyrics_translation: String,
    lyrics_notice: Option<String>,
    lyrics_searched: bool,
    svsep_input: Option<PathBuf>,
    svsep_stems: Option<Stems>,
    svsep_job: Option<u64>,
    svsep_prepare_job: Option<u64>,
    svsep_notice: Option<String>,
    midi_input: Option<PathBuf>,
    midi_outputs: Option<midi::Outputs>,
    midi_job: Option<u64>,
    midi_prepare_job: Option<u64>,
    midi_notice: Option<String>,
    midi_steps: usize,
    midi_device: MidiDevice,
    announcements: Option<Vec<Announcement>>,
    announce_error: Option<String>,
    announce_loading: bool,
    update_checking: bool,
    update_info: Option<UpdateInfo>,
    update_error: Option<String>,
    update_notice: Option<String>,
    update_job: Option<u64>,
    update_file: Option<PathBuf>,
}

impl VSynthApp {
    fn text(&self) -> &'static Strings {
        i18n::strings(self.config.language)
    }

    pub fn new(config: Config, inputs: AppInputs, job_center: Entity<JobCenter>) -> Self {
        let (resources, resource_error) = match Resources::load() {
            Ok(resources) => (resources, None),
            Err(error) => (Resources::default(), Some(error)),
        };
        Self {
            page: Page::Dashboard,
            config,
            notice: None,
            tools: None,
            scanning_tools: false,
            output_input: inputs.output,
            download_input: inputs.download,
            ext_input: inputs.ext,
            resources,
            resource_error,
            resource_search: inputs.resource_search,
            resource_group: None,
            webview: None,
            webview_error: None,
            webview_source: None,
            pv_ready: false,
            pv_status: None,
            pv_pending_lyrics: None,
            pv_injected: None,
            pv_export_dir: None,
            job_center,
            tool_job: None,
            dependency_job: None,
            convert_inputs: Vec::new(),
            convert_format: formats::DEFAULT,
            convert_preview: None,
            convert_preview_job: None,
            convert_job: None,
            convert_notice: None,
            audio_input: None,
            audio_info: None,
            audio_peaks: Vec::new(),
            audio_selection: None,
            audio_drag: None,
            audio_load_job: None,
            audio_run_job: None,
            audio_notice: None,
            audio_operation: AudioOp::Convert,
            audio_format: AudioFormat::Wav,
            audio_semitones: 2,
            audio_ratio: 1.25,
            audio_lufs: -16,
            waveform_bounds: Rc::new(RefCell::new(None)),
            video_url_input: inputs.video_url,
            video_info: None,
            video_quality: None,
            video_parse_job: None,
            video_page_job: None,
            video_download_job: None,
            video_notice: None,
            video_output: None,
            video_webview: None,
            video_webview_error: None,
            media_server: None,
            lyrics_query: inputs.lyrics_query,
            lyrics_editor: inputs.lyrics_editor,
            lyrics_results: Vec::new(),
            lyrics_song: None,
            lyrics_translation: String::new(),
            lyrics_notice: None,
            lyrics_searched: false,
            svsep_input: None,
            svsep_stems: None,
            svsep_job: None,
            svsep_prepare_job: None,
            svsep_notice: None,
            midi_input: None,
            midi_outputs: None,
            midi_job: None,
            midi_prepare_job: None,
            midi_notice: None,
            midi_steps: 8,
            midi_device: MidiDevice::Auto,
            announcements: None,
            announce_error: None,
            announce_loading: false,
            update_checking: false,
            update_info: None,
            update_error: None,
            update_notice: None,
            update_job: None,
            update_file: None,
        }
    }

    fn set_page(&mut self, page: Page, window: &mut Window, cx: &mut Context<Self>) {
        if self.page == Page::Pv
            && page != Page::Pv
            && let Some(webview) = &self.webview
        {
            webview.update(cx, |webview, _| webview.hide());
        }
        if self.page == Page::Video && page != Page::Video {
            if let Some(webview) = &self.video_webview {
                webview.update(cx, |webview, _| webview.hide());
            }
            self.video_webview = None;
            self.media_server = None;
        }
        if page == Page::Pv {
            self.ensure_webview(window, cx);
            if let Some(webview) = &self.webview {
                webview.update(cx, |webview, _| webview.show());
            }
        }
        self.page = page;
        if page == Page::Pv {
            self.maybe_inject_pv(cx);
        }
        cx.notify();
    }

    fn ensure_webview(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.webview.is_some() || self.webview_error.is_some() {
            return;
        }
        let jizura_root = crate::jizura::asset_dir();
        let has_jizura = jizura_root.is_some();
        let s = self.text();
        let (pv_sender, pv_receiver) = async_channel::unbounded::<String>();
        let mut builder = match jizura_root {
            Some(root) => {
                self.webview_source = Some(s.custom_protocol.to_string());
                wry::WebViewBuilder::new()
                    .with_custom_protocol(crate::jizura::SCHEME.into(), move |_, request| {
                        crate::jizura::serve(&root, request)
                    })
                    .with_url(crate::jizura::START_URL)
            }
            None => {
                self.webview_source = Some(s.demo_fallback.to_string());
                wry::WebViewBuilder::new().with_html(WEBVIEW_DEMO)
            }
        };
        builder = builder.with_ipc_handler(move |request| {
            let _ = pv_sender.try_send(request.body().clone());
        });
        if has_jizura {
            builder = builder.with_initialization_script(crate::jizura::save_bridge_script());
        }
        match WebView::build(builder, window, cx) {
            Ok(webview) => {
                self.webview = Some(cx.new(|_| webview));
                cx.spawn(async move |this, cx| {
                    while let Ok(message) = pv_receiver.recv().await {
                        if this
                            .update(cx, |this, cx| this.handle_pv_message(&message, cx))
                            .is_err()
                        {
                            break;
                        }
                    }
                })
                .detach();
            }
            Err(error) => {
                self.webview_error = Some(format!("{}：{error}", s.webview_failed));
            }
        }
    }

    fn handle_pv_message(&mut self, body: &str, cx: &mut Context<Self>) {
        let Ok(message) = serde_json::from_str::<serde_json::Value>(body) else {
            return;
        };
        let ready_label = self.text().pv_ready;
        let fill_ok = self.text().pv_fill_ok;
        let fill_failed = self.text().pv_fill_failed;
        let saved_label = self.text().pv_saved;
        let save_failed = self.text().pv_save_failed;
        match message["type"].as_str() {
            Some("ready") => {
                self.pv_ready = true;
                if self.pv_pending_lyrics.is_some()
                    && self.pv_injected.as_deref() != self.pv_pending_lyrics.as_deref()
                {
                    self.inject_pv_lyrics(cx);
                } else if self.pv_status.is_none() {
                    self.pv_status = Some(ready_label.to_string());
                }
            }
            Some("fill") => {
                if message["ok"].as_bool().unwrap_or(false) {
                    self.pv_injected = self.pv_pending_lyrics.clone();
                    self.pv_status = Some(fill_ok.to_string());
                } else {
                    self.pv_status = Some(fill_failed.to_string());
                }
            }
            Some("saved") => {
                let path = message["path"].as_str().unwrap_or_default();
                if let Some(parent) = Path::new(path).parent() {
                    self.pv_export_dir = Some(parent.to_path_buf());
                }
                self.pv_status = Some(if path.is_empty() {
                    saved_label.to_string()
                } else {
                    format!("{saved_label}：{path}")
                });
            }
            Some("save_canceled") => {
                self.pv_status = Some(self.text().pv_save_canceled.to_string());
            }
            Some("save_error") => {
                let detail = message["message"].as_str().unwrap_or_default();
                self.pv_status = Some(if detail.is_empty() {
                    save_failed.to_string()
                } else {
                    format!("{save_failed}：{detail}")
                });
            }
            _ => {}
        }
        cx.notify();
    }

    fn maybe_inject_pv(&mut self, cx: &mut Context<Self>) {
        if !self.pv_ready {
            return;
        }
        if self.pv_pending_lyrics.is_some()
            && self.pv_injected.as_deref() != self.pv_pending_lyrics.as_deref()
        {
            self.inject_pv_lyrics(cx);
        }
    }

    fn inject_pv_lyrics(&mut self, cx: &mut Context<Self>) {
        let Some(text) = self.pv_pending_lyrics.clone() else {
            return;
        };
        let Some(webview) = &self.webview else {
            return;
        };
        let Ok(literal) = serde_json::to_string(&text) else {
            return;
        };
        let script = format!("window.__vss && window.__vss.fillLyrics({literal});");
        let result = webview.update(cx, |webview, _| webview.raw().evaluate_script(&script));
        self.pv_status = Some(if let Err(error) = result {
            format!("{}：{error}", self.text().pv_fill_failed)
        } else {
            self.text().pv_filling.to_string()
        });
        cx.notify();
    }

    fn import_pv_lyrics(&mut self, cx: &mut Context<Self>) {
        let Some(path) = rfd::FileDialog::new()
            .add_filter("Lyrics", &["lrc", "txt"])
            .set_title(self.text().pv_import_lyrics)
            .pick_file()
        else {
            return;
        };
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) => {
                self.pv_status = Some(format!("{}：{error}", self.text().pv_import_failed));
                cx.notify();
                return;
            }
        };
        let (text, gbk) = lyrics::decode_text(bytes);
        let text = text.trim().to_string();
        if text.is_empty() {
            self.pv_status = Some(self.text().pv_fill_failed.to_string());
            cx.notify();
            return;
        }
        let note = if gbk { self.text().pv_gbk_note } else { "" };
        self.pv_pending_lyrics = Some(text);
        self.pv_injected = None;
        self.pv_status = Some(format!("{}{note}", self.text().pv_import_ok));
        self.maybe_inject_pv(cx);
        cx.notify();
    }

    fn open_pv_export_dir(&mut self, cx: &mut Context<Self>) {
        let Some(directory) = &self.pv_export_dir else {
            return;
        };
        if let Err(error) = open::that(directory) {
            self.pv_status = Some(format!("{}：{error}", self.text().pv_save_failed));
        }
        cx.notify();
    }

    fn send_lyrics_to_pv(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let lyric = self.lyrics_editor.read(cx).value().trim().to_string();
        if lyric.is_empty() {
            self.lyrics_notice = Some(self.text().lyrics_no_lyrics.to_string());
            cx.notify();
            return;
        }
        let mut parts = vec![lyric];
        let translation = self.lyrics_translation.trim().to_string();
        if !translation.is_empty() {
            parts.push(translation);
            parts.push(self.text().pv_bilingual_note.to_string());
        }
        self.pv_pending_lyrics = Some(parts.join("\n"));
        self.pv_injected = None;
        self.pv_status = Some(self.text().pv_loading.to_string());
        self.set_page(Page::Pv, window, cx);
    }

    pub fn watch_resource_search(&self, cx: &mut Context<Self>) {
        cx.subscribe(&self.resource_search, |_, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
        })
        .detach();
    }

    fn open_resource(&mut self, url: &str, cx: &mut Context<Self>) {
        match open::that(url) {
            Ok(()) => self.notice = None,
            Err(error) => self.notice = Some(format!("打开链接失败：{error}")),
        }
        cx.notify();
    }

    fn save_paths(&mut self, cx: &mut Context<Self>) {
        self.config.output_dir = self.output_input.read(cx).value().trim().to_string();
        self.config.download_dir = self.download_input.read(cx).value().trim().to_string();
        self.config.ext_dir = self.ext_input.read(cx).value().trim().to_string();
        self.notice = self.config.save().err();
        cx.notify();
    }

    pub fn refresh_tools(&mut self, cx: &mut Context<Self>) {
        if self.scanning_tools {
            return;
        }
        self.scanning_tools = true;
        let root = crate::config::app_root();
        let s = self.text();
        let job = self
            .job_center
            .read(cx)
            .start(s.detect_tools_job, move |ctx| {
                crate::tools::detect_with(
                    &root,
                    |fraction, message| {
                        ctx.log(message);
                        ctx.progress(fraction, message);
                    },
                    || ctx.is_canceled(),
                )
            });
        self.tool_job = Some(job.id);
        let job_id = job.id;
        cx.spawn(async move |this, cx| {
            let outcome = job.result.recv().await;
            let Some(this) = this.upgrade() else {
                return;
            };
            this.update(cx, |this, cx| {
                this.scanning_tools = false;
                if this.tool_job == Some(job_id) {
                    this.tool_job = None;
                }
                match outcome {
                    Ok(JobOutcome::Done(status)) => {
                        this.tools = Some(status);
                        this.notice = None;
                    }
                    Ok(JobOutcome::Failed(error)) => this.notice = Some(error),
                    Ok(JobOutcome::Canceled) => {
                        this.notice = Some(this.text().check_canceled.to_string());
                    }
                    Err(_) => this.notice = Some(this.text().check_interrupted.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn install_dependency(&mut self, id: DependencyId, cx: &mut Context<Self>) {
        if self
            .dependency_job
            .is_some_and(|(_, job)| self.job_center.read(cx).is_running(job))
        {
            return;
        }
        let title = format!(
            "{} {}",
            self.text().install_job,
            dependencies::info(id).name
        );
        let job = self
            .job_center
            .read(cx)
            .start(title, move |ctx| dependencies::install(id, &ctx));
        self.dependency_job = Some((id, job.id));
        let job_id = job.id;
        cx.spawn(async move |this, cx| {
            let outcome = job.result.recv().await;
            let Some(this) = this.upgrade() else {
                return;
            };
            this.update(cx, |this, cx| {
                if this.dependency_job == Some((id, job_id)) {
                    this.dependency_job = None;
                }
                match outcome {
                    Ok(JobOutcome::Done(())) => {
                        this.notice = None;
                        if matches!(
                            id,
                            DependencyId::LibreSvip | DependencyId::Ffmpeg | DependencyId::YtDlp
                        ) {
                            this.refresh_tools(cx);
                        }
                    }
                    Ok(JobOutcome::Failed(error)) => this.notice = Some(error),
                    Ok(JobOutcome::Canceled) => {
                        this.notice = Some(this.text().install_canceled.to_string());
                    }
                    Err(_) => this.notice = Some(this.text().install_interrupted.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn cancel_dependency(&mut self, cx: &mut Context<Self>) {
        if let Some((_, id)) = self.dependency_job {
            self.job_center.read(cx).cancel(id);
            cx.notify();
        }
    }

    fn dependency_status(&self, id: DependencyId) -> dependencies::Status {
        let mut status = dependencies::status(id);
        if status.ready {
            return status;
        }
        let tool = match id {
            DependencyId::Ffmpeg => self.tools.as_ref().map(|tools| &tools.ffmpeg),
            DependencyId::YtDlp => self.tools.as_ref().map(|tools| &tools.ytdlp),
            _ => None,
        };
        if let Some(tool) = tool.filter(|tool| tool.available) {
            status.ready = true;
            if let Some(path) = &tool.path {
                status.location = PathBuf::from(path);
            }
        }
        status
    }

    fn render_dependencies(
        &self,
        ids: &[DependencyId],
        cx: &mut Context<Self>,
        include_ready: bool,
    ) -> AnyElement {
        let theme = cx.theme();
        let muted = theme.muted_foreground;
        let entity = cx.entity();
        let s = self.text();
        let active = self.dependency_job;
        let active_running =
            active.is_some_and(|(_, job)| self.job_center.read(cx).is_running(job));
        let snapshot = active.and_then(|(_, job)| self.job_center.read(cx).snapshot(job));
        let mut rows = v_flex().gap_2();
        let mut count = 0;
        for &id in ids {
            let info = dependencies::info(id);
            let status = self.dependency_status(id);
            if status.ready && !include_ready {
                continue;
            }
            count += 1;
            let is_active = active_running && active.is_some_and(|(active_id, _)| active_id == id);
            let row_entity = entity.clone();
            let button = if is_active {
                Button::new(SharedString::from(format!("dep-cancel-{}", info.name)))
                    .label(s.cancel_install)
                    .compact()
                    .on_click(move |_, _, cx| {
                        row_entity.update(cx, |this, cx| this.cancel_dependency(cx));
                    })
                    .into_any_element()
            } else if !status.ready {
                let install_entity = entity.clone();
                Button::new(SharedString::from(format!("dep-install-{}", info.name)))
                    .label(s.install)
                    .primary()
                    .compact()
                    .disabled(active_running)
                    .on_click(move |_, _, cx| {
                        install_entity.update(cx, |this, cx| this.install_dependency(id, cx));
                    })
                    .into_any_element()
            } else {
                div().into_any_element()
            };
            let color = if status.ready {
                theme.success
            } else if is_active {
                theme.primary
            } else {
                theme.danger
            };
            let status_label = if is_active {
                s.installing
            } else if status.ready {
                s.installed
            } else {
                s.needs_download
            };
            let detail = if is_active {
                snapshot
                    .as_ref()
                    .map(|snap| snap.message.clone())
                    .unwrap_or_else(|| s.installing.to_string())
            } else if status.ready {
                format!(
                    "{} · {}: {}",
                    dependency_purpose(id, s),
                    s.location,
                    status.location.display()
                )
            } else {
                format!(
                    "{} · {}: {:.1} MB",
                    dependency_purpose(id, s),
                    s.download_size,
                    info.size as f64 / 1_000_000.0
                )
            };
            rows = rows.child(
                h_flex()
                    .justify_between()
                    .items_center()
                    .gap_4()
                    .py_2()
                    .border_b_1()
                    .border_color(theme.border)
                    .child(
                        v_flex()
                            .gap_1()
                            .child(div().text_sm().child(format!(
                                "{} · {}",
                                info.name,
                                dependencies::version(id)
                            )))
                            .child(div().text_xs().text_color(muted).child(detail)),
                    )
                    .child(
                        h_flex()
                            .items_center()
                            .gap_2()
                            .child(announce_badge(status_label, color, theme.radius))
                            .child(button),
                    ),
            );
        }
        if count == 0 {
            return div().into_any_element();
        }
        GroupBox::new()
            .id("dependencies")
            .outline()
            .title(s.dependencies)
            .child(rows)
            .into_any_element()
    }

    fn add_convert_files(&mut self, cx: &mut Context<Self>) {
        let Some(paths) = rfd::FileDialog::new()
            .add_filter("Project files", formats::PICK_EXTENSIONS)
            .pick_files()
        else {
            return;
        };
        for path in paths {
            if path.is_file() && !self.convert_inputs.contains(&path) {
                self.convert_inputs.push(path);
            }
        }
        self.convert_preview = None;
        self.convert_notice = None;
        cx.notify();
    }

    fn clear_convert_files(&mut self, cx: &mut Context<Self>) {
        self.convert_inputs.clear();
        self.convert_preview = None;
        self.convert_notice = None;
        cx.notify();
    }

    fn remove_convert_file(&mut self, index: usize, cx: &mut Context<Self>) {
        if index < self.convert_inputs.len() {
            self.convert_inputs.remove(index);
            self.convert_preview = None;
            self.convert_notice = None;
            cx.notify();
        }
    }

    fn choose_convert_output_dir(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let current = self.output_input.read(cx).value().to_string();
        let Some(path) = pick_folder(&current) else {
            return;
        };
        let value = path.to_string_lossy().to_string();
        self.output_input.update(cx, |state, cx| {
            state.set_value(value.clone(), window, cx);
        });
        self.config.output_dir = value;
        self.notice = self.config.save().err();
        cx.notify();
    }

    fn inspect_convert(&mut self, cx: &mut Context<Self>) {
        let Some(input) = self.convert_inputs.first().cloned() else {
            return;
        };
        if self
            .convert_preview_job
            .is_some_and(|id| self.job_center.read(cx).is_running(id))
        {
            return;
        }
        let s = self.text();
        let job_input = input.clone();
        let job = self
            .job_center
            .read(cx)
            .start(s.convert_inspect, move |ctx| {
                libresvip::inspect(&job_input, &ctx)
            });
        self.convert_preview_job = Some(job.id);
        let job_id = job.id;
        cx.spawn(async move |this, cx| {
            let outcome = job.result.recv().await;
            let Some(this) = this.upgrade() else {
                return;
            };
            this.update(cx, |this, cx| {
                if this.convert_preview_job == Some(job_id) {
                    this.convert_preview_job = None;
                }
                match outcome {
                    Ok(JobOutcome::Done(info)) => {
                        this.convert_preview = Some((input.clone(), info));
                        this.convert_notice = None;
                    }
                    Ok(JobOutcome::Failed(error)) => this.convert_notice = Some(error),
                    Ok(JobOutcome::Canceled) => {
                        this.convert_notice = Some(this.text().job_canceled.to_string());
                    }
                    Err(_) => this.convert_notice = Some(this.text().job_failed.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn start_convert(&mut self, cx: &mut Context<Self>) {
        if self.convert_inputs.is_empty()
            || self
                .convert_job
                .is_some_and(|id| self.job_center.read(cx).is_running(id))
        {
            return;
        }
        let inputs = self.convert_inputs.clone();
        let format = *self.convert_format;
        let output_dir = {
            let value = self.output_input.read(cx).value().trim().to_string();
            (!value.is_empty()).then(|| PathBuf::from(value))
        };
        let s = self.text();
        let job = self.job_center.read(cx).start(s.page_convert, move |ctx| {
            let total = inputs.len().max(1);
            let mut outputs = Vec::new();
            for (index, input) in inputs.iter().enumerate() {
                if ctx.is_canceled() {
                    return Err("已取消".to_string());
                }
                let output = unique_output(input, &format, output_dir.as_deref());
                let base = index as f32 / total as f32;
                let span = 1.0 / total as f32;
                libresvip::convert_with(
                    input,
                    &output,
                    |fraction, message| {
                        ctx.progress(fraction.map(|value| base + value * span), message);
                    },
                    |line| ctx.log(line),
                    || ctx.is_canceled(),
                )?;
                outputs.push(output);
            }
            Ok(outputs)
        });
        self.convert_job = Some(job.id);
        self.convert_notice = None;
        let job_id = job.id;
        cx.spawn(async move |this, cx| {
            let outcome = job.result.recv().await;
            let Some(this) = this.upgrade() else {
                return;
            };
            this.update(cx, |this, cx| {
                if this.convert_job == Some(job_id) {
                    this.convert_job = None;
                }
                match outcome {
                    Ok(JobOutcome::Done(outputs)) => {
                        this.convert_notice =
                            Some(format!("{}: {}", this.text().convert_done, outputs.len()));
                    }
                    Ok(JobOutcome::Failed(error)) => this.convert_notice = Some(error),
                    Ok(JobOutcome::Canceled) => {
                        this.convert_notice = Some(this.text().job_canceled.to_string());
                    }
                    Err(_) => this.convert_notice = Some(this.text().job_failed.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn cancel_convert(&mut self, cx: &mut Context<Self>) {
        if let Some(id) = self.convert_job {
            self.job_center.read(cx).cancel(id);
            cx.notify();
        }
    }

    fn add_audio_file(&mut self, cx: &mut Context<Self>) {
        const FILTER: &[&str] = &[
            "wav", "mp3", "flac", "m4a", "ogg", "aac", "opus", "mp4", "mkv", "mov", "webm", "avi",
        ];
        let Some(path) = rfd::FileDialog::new()
            .add_filter("Audio / Video", FILTER)
            .pick_file()
        else {
            return;
        };
        self.load_audio(path, cx);
    }

    fn load_audio(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        if self
            .audio_load_job
            .is_some_and(|id| self.job_center.read(cx).is_running(id))
        {
            return;
        }
        self.audio_input = Some(path.clone());
        self.audio_info = None;
        self.audio_peaks.clear();
        self.audio_selection = None;
        self.audio_drag = None;
        self.audio_notice = None;
        let s = self.text();
        let job = self.job_center.read(cx).start(s.audio_reading, move |ctx| {
            let info = audio::probe(&path)?;
            let peaks = audio::waveform(&path, 700, &ctx)?;
            Ok((info, peaks))
        });
        self.audio_load_job = Some(job.id);
        let job_id = job.id;
        cx.spawn(async move |this, cx| {
            let outcome = job.result.recv().await;
            let Some(this) = this.upgrade() else {
                return;
            };
            this.update(cx, |this, cx| {
                if this.audio_load_job == Some(job_id) {
                    this.audio_load_job = None;
                }
                match outcome {
                    Ok(JobOutcome::Done((info, peaks))) => {
                        this.audio_info = Some(info);
                        this.audio_peaks = peaks;
                        this.audio_notice = None;
                    }
                    Ok(JobOutcome::Failed(error)) => this.audio_notice = Some(error),
                    Ok(JobOutcome::Canceled) => {
                        this.audio_notice = Some(this.text().job_canceled.to_string());
                    }
                    Err(_) => this.audio_notice = Some(this.text().job_failed.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn start_audio(&mut self, cx: &mut Context<Self>) {
        if self
            .audio_run_job
            .is_some_and(|id| self.job_center.read(cx).is_running(id))
        {
            return;
        }
        let Some(input) = self.audio_input.clone() else {
            return;
        };
        let Some(info) = self.audio_info.clone() else {
            return;
        };
        let operation = match self.audio_operation {
            AudioOp::Convert => AudioOperation::Convert,
            AudioOp::Extract => AudioOperation::Extract,
            AudioOp::Pitch => AudioOperation::Pitch {
                semitones: self.audio_semitones as f32,
            },
            AudioOp::Speed => AudioOperation::Speed {
                ratio: self.audio_ratio,
            },
            AudioOp::Trim => {
                let Some((start, end)) = self.audio_selection else {
                    self.audio_notice = Some(self.text().audio_need_selection.to_string());
                    cx.notify();
                    return;
                };
                let (start, end) = (start.min(end), start.max(end));
                if end - start < 0.005 || info.duration <= 0.0 {
                    self.audio_notice = Some(self.text().audio_need_selection.to_string());
                    cx.notify();
                    return;
                }
                AudioOperation::Trim {
                    start: start as f64 * info.duration,
                    end: end as f64 * info.duration,
                }
            }
            AudioOp::Loudness => AudioOperation::Loudness {
                target_lufs: self.audio_lufs as f32,
            },
        };
        let output = audio_output_path(&input, self.audio_operation, self.audio_format);
        let job_output = output.clone();
        let format = self.audio_format;
        let s = self.text();
        let job = self.job_center.read(cx).start(s.page_audio, move |ctx| {
            audio::run(&input, &job_output, &operation, format, &ctx)
        });
        self.audio_run_job = Some(job.id);
        self.audio_notice = None;
        let job_id = job.id;
        cx.spawn(async move |this, cx| {
            let outcome = job.result.recv().await;
            let Some(this) = this.upgrade() else {
                return;
            };
            this.update(cx, |this, cx| {
                if this.audio_run_job == Some(job_id) {
                    this.audio_run_job = None;
                }
                match outcome {
                    Ok(JobOutcome::Done(())) => {
                        this.audio_notice =
                            Some(format!("{}: {}", this.text().audio_done, output.display()));
                    }
                    Ok(JobOutcome::Failed(error)) => this.audio_notice = Some(error),
                    Ok(JobOutcome::Canceled) => {
                        this.audio_notice = Some(this.text().job_canceled.to_string());
                    }
                    Err(_) => this.audio_notice = Some(this.text().job_failed.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn cancel_audio(&mut self, cx: &mut Context<Self>) {
        if let Some(id) = self.audio_run_job {
            self.job_center.read(cx).cancel(id);
            cx.notify();
        }
    }

    fn parse_video(&mut self, cx: &mut Context<Self>) {
        if self
            .video_parse_job
            .is_some_and(|id| self.job_center.read(cx).is_running(id))
            || self
                .video_download_job
                .is_some_and(|id| self.job_center.read(cx).is_running(id))
        {
            return;
        }
        let url = self.video_url_input.read(cx).value().trim().to_string();
        if url.is_empty() {
            self.video_notice = Some(self.text().video_url_hint.to_string());
            cx.notify();
            return;
        }
        let s = self.text();
        let job = self
            .job_center
            .read(cx)
            .start(s.video_parse, move |_| bili::parse(&url));
        self.video_parse_job = Some(job.id);
        self.video_notice = None;
        let job_id = job.id;
        cx.spawn(async move |this, cx| {
            let outcome = job.result.recv().await;
            let Some(this) = this.upgrade() else {
                return;
            };
            this.update(cx, |this, cx| {
                if this.video_parse_job == Some(job_id) {
                    this.video_parse_job = None;
                }
                match outcome {
                    Ok(JobOutcome::Done(video)) => {
                        this.video_quality = video.qualities.first().map(|quality| quality.qn);
                        this.video_info = Some(video);
                        this.video_output = None;
                        this.video_notice = None;
                    }
                    Ok(JobOutcome::Failed(error)) => this.video_notice = Some(error),
                    Ok(JobOutcome::Canceled) => {
                        this.video_notice = Some(this.text().job_canceled.to_string());
                    }
                    Err(_) => this.video_notice = Some(this.text().job_failed.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn select_video_page(&mut self, index: usize, cx: &mut Context<Self>) {
        let Some(info) = &mut self.video_info else {
            return;
        };
        if index >= info.pages.len() || info.page_index == index {
            return;
        }
        if self
            .video_page_job
            .is_some_and(|id| self.job_center.read(cx).is_running(id))
        {
            return;
        }
        info.page_index = index;
        info.qualities.clear();
        self.video_quality = None;
        self.video_notice = None;
        let bvid = info.bvid.clone();
        let cid = info.pages[index].cid;
        let s = self.text();
        let job = self
            .job_center
            .read(cx)
            .start(s.video_parsing, move |_| bili::qualities_for(&bvid, cid));
        self.video_page_job = Some(job.id);
        let job_id = job.id;
        cx.spawn(async move |this, cx| {
            let outcome = job.result.recv().await;
            let Some(this) = this.upgrade() else {
                return;
            };
            this.update(cx, |this, cx| {
                if this.video_page_job == Some(job_id) {
                    this.video_page_job = None;
                }
                match outcome {
                    Ok(JobOutcome::Done(qualities)) => {
                        if let Some(info) = &mut this.video_info {
                            info.qualities = qualities;
                        }
                        this.video_quality = this
                            .video_info
                            .as_ref()
                            .and_then(|info| info.qualities.first())
                            .map(|quality| quality.qn);
                    }
                    Ok(JobOutcome::Failed(error)) => this.video_notice = Some(error),
                    Ok(JobOutcome::Canceled) => {
                        this.video_notice = Some(this.text().job_canceled.to_string());
                    }
                    Err(_) => this.video_notice = Some(this.text().job_failed.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn download_video(&mut self, cx: &mut Context<Self>) {
        if self
            .video_download_job
            .is_some_and(|id| self.job_center.read(cx).is_running(id))
        {
            return;
        }
        let Some(info) = self.video_info.clone() else {
            return;
        };
        let Some(quality) = self.video_quality else {
            return;
        };
        let Some(page) = info.pages.get(info.page_index) else {
            return;
        };
        let directory = self.download_directory(cx);
        let name = video_file_name(&info, page, quality);
        let output = unique_video_output(&directory, &name);
        let job_output = output.clone();
        let bvid = info.bvid.clone();
        let cid = page.cid;
        let s = self.text();
        let job = self
            .job_center
            .read(cx)
            .start(s.video_download, move |ctx| {
                bili::download(&bvid, cid, quality, &job_output, &ctx)
            });
        self.video_download_job = Some(job.id);
        self.video_notice = None;
        let job_id = job.id;
        cx.spawn(async move |this, cx| {
            let outcome = job.result.recv().await;
            let Some(this) = this.upgrade() else {
                return;
            };
            this.update(cx, |this, cx| {
                if this.video_download_job == Some(job_id) {
                    this.video_download_job = None;
                }
                match outcome {
                    Ok(JobOutcome::Done(())) => {
                        this.video_output = Some(output.clone());
                        this.video_notice =
                            Some(format!("{}: {}", this.text().video_done, output.display()));
                    }
                    Ok(JobOutcome::Failed(error)) => this.video_notice = Some(error),
                    Ok(JobOutcome::Canceled) => {
                        this.video_notice = Some(this.text().job_canceled.to_string());
                    }
                    Err(_) => this.video_notice = Some(this.text().job_failed.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn cancel_video_download(&mut self, cx: &mut Context<Self>) {
        if let Some(id) = self.video_download_job {
            self.job_center.read(cx).cancel(id);
            cx.notify();
        }
    }

    fn open_video_folder(&mut self, cx: &mut Context<Self>) {
        let Some(output) = &self.video_output else {
            return;
        };
        let directory = output.parent().unwrap_or_else(|| Path::new("."));
        if let Err(error) = open::that(directory) {
            self.video_notice = Some(format!("打开目录失败：{error}"));
        }
        cx.notify();
    }

    fn open_video_preview(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(output) = self.video_output.clone() else {
            return;
        };
        let title = self
            .video_info
            .as_ref()
            .map(|info| info.title.clone())
            .unwrap_or_else(|| "video".to_string());
        self.video_webview = None;
        self.media_server = None;
        self.video_webview_error = None;
        let s = self.text();
        let result = MediaServer::start(output, title).and_then(|server| {
            let url = server.url().to_string();
            WebView::build(wry::WebViewBuilder::new().with_url(url), window, cx)
                .map(|webview| (server, webview))
                .map_err(|error| format!("{}：{error}", s.video_preview_error))
        });
        match result {
            Ok((server, webview)) => {
                self.media_server = Some(server);
                self.video_webview = Some(cx.new(|_| webview));
            }
            Err(error) => self.video_webview_error = Some(error),
        }
        cx.notify();
    }

    fn close_video_preview(&mut self, cx: &mut Context<Self>) {
        if let Some(webview) = &self.video_webview {
            webview.update(cx, |webview, _| webview.hide());
        }
        self.video_webview = None;
        self.media_server = None;
        cx.notify();
    }

    fn search_lyrics(&mut self, cx: &mut Context<Self>) {
        let query = self.lyrics_query.read(cx).value().trim().to_string();
        self.lyrics_searched = true;
        match lyrics::search(&query, 10) {
            Ok(results) => {
                self.lyrics_results = results;
                self.lyrics_notice = None;
            }
            Err(error) => {
                self.lyrics_results.clear();
                self.lyrics_notice = Some(error);
            }
        }
        cx.notify();
    }

    fn select_lyrics_song(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        let result = lyrics::detail(id).and_then(|song| {
            let fetched = lyrics::lyrics(id)?;
            Ok((song, fetched))
        });
        match result {
            Ok((song, fetched)) => {
                self.lyrics_song = Some(song);
                self.lyrics_translation = fetched.translation;
                self.lyrics_editor.update(cx, |editor, cx| {
                    editor.set_value(fetched.lrc, window, cx);
                });
                self.lyrics_notice = None;
            }
            Err(error) => self.lyrics_notice = Some(error),
        }
        cx.notify();
    }

    fn save_lyrics(&mut self, srt: bool, cx: &mut Context<Self>) {
        let text = self.lyrics_editor.read(cx).value().to_string();
        if text.trim().is_empty() {
            self.lyrics_notice = Some(self.text().lyrics_no_lyrics.to_string());
            cx.notify();
            return;
        }
        let content = if srt { lyrics::lrc_to_srt(&text) } else { text };
        let stem = self
            .lyrics_song
            .as_ref()
            .map(|song| sanitize_filename(&song.name))
            .unwrap_or_else(|| "lyrics".to_string());
        let extension = if srt { "srt" } else { "lrc" };
        let Some(path) = rfd::FileDialog::new()
            .set_file_name(format!("{stem}.{extension}"))
            .add_filter(extension.to_uppercase(), &[extension])
            .save_file()
        else {
            return;
        };
        match std::fs::write(&path, content) {
            Ok(()) => {
                let message = if srt {
                    self.text().lyrics_save_srt
                } else {
                    self.text().lyrics_save_lrc
                };
                self.lyrics_notice = Some(format!("{message}: {}", path.display()));
            }
            Err(error) => {
                self.lyrics_notice = Some(format!("保存歌词失败：{error}"));
            }
        }
        cx.notify();
    }

    fn download_lyrics_cover(&mut self, cx: &mut Context<Self>) {
        let Some(song) = self.lyrics_song.clone() else {
            self.lyrics_notice = Some(self.text().lyrics_no_song.to_string());
            cx.notify();
            return;
        };
        let directory = self.download_directory(cx);
        match lyrics::download_cover(&song.cover_url, &directory, &song.name) {
            Ok(path) => {
                self.lyrics_notice = Some(format!(
                    "{}: {}",
                    self.text().lyrics_download_cover,
                    path.display()
                ));
            }
            Err(error) => self.lyrics_notice = Some(error),
        }
        cx.notify();
    }

    fn pick_svsep_input(&mut self, cx: &mut Context<Self>) {
        const FILTER: &[&str] = &[
            "wav", "mp3", "flac", "m4a", "ogg", "aac", "opus", "mp4", "mkv", "mov", "webm", "avi",
        ];
        let Some(path) = rfd::FileDialog::new()
            .add_filter("Audio / Video", FILTER)
            .pick_file()
        else {
            return;
        };
        self.svsep_input = Some(path);
        self.svsep_stems = None;
        self.svsep_notice = None;
        cx.notify();
    }

    fn prepare_svsep(&mut self, cx: &mut Context<Self>) {
        if self
            .svsep_prepare_job
            .is_some_and(|id| self.job_center.read(cx).is_running(id))
        {
            return;
        }
        let s = self.text();
        let job = self
            .job_center
            .read(cx)
            .start(s.svsep_prepare, move |ctx| svsep::ensure_ready(&ctx));
        self.svsep_prepare_job = Some(job.id);
        self.svsep_notice = None;
        let job_id = job.id;
        cx.spawn(async move |this, cx| {
            let outcome = job.result.recv().await;
            let Some(this) = this.upgrade() else {
                return;
            };
            this.update(cx, |this, cx| {
                if this.svsep_prepare_job == Some(job_id) {
                    this.svsep_prepare_job = None;
                }
                match outcome {
                    Ok(JobOutcome::Done(())) => this.svsep_notice = None,
                    Ok(JobOutcome::Failed(error)) => this.svsep_notice = Some(error),
                    Ok(JobOutcome::Canceled) => {
                        this.svsep_notice = Some(this.text().job_canceled.to_string());
                    }
                    Err(_) => this.svsep_notice = Some(this.text().job_failed.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn start_svsep(&mut self, cx: &mut Context<Self>) {
        if self
            .svsep_job
            .is_some_and(|id| self.job_center.read(cx).is_running(id))
        {
            return;
        }
        let Some(input) = self.svsep_input.clone() else {
            return;
        };
        let output_dir = input
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let s = self.text();
        let job = self.job_center.read(cx).start(s.svsep_run, move |ctx| {
            svsep::separate(&input, &output_dir, &ctx)
        });
        self.svsep_job = Some(job.id);
        self.svsep_notice = None;
        let job_id = job.id;
        cx.spawn(async move |this, cx| {
            let outcome = job.result.recv().await;
            let Some(this) = this.upgrade() else {
                return;
            };
            this.update(cx, |this, cx| {
                if this.svsep_job == Some(job_id) {
                    this.svsep_job = None;
                }
                match outcome {
                    Ok(JobOutcome::Done(stems)) => {
                        this.svsep_stems = Some(stems);
                        this.svsep_notice = Some(this.text().svsep_done.to_string());
                    }
                    Ok(JobOutcome::Failed(error)) => this.svsep_notice = Some(error),
                    Ok(JobOutcome::Canceled) => {
                        this.svsep_notice = Some(this.text().job_canceled.to_string());
                    }
                    Err(_) => this.svsep_notice = Some(this.text().job_failed.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn cancel_svsep(&mut self, cx: &mut Context<Self>) {
        if let Some(id) = self.svsep_job.or(self.svsep_prepare_job) {
            self.job_center.read(cx).cancel(id);
            cx.notify();
        }
    }

    fn open_svsep_folder(&mut self, cx: &mut Context<Self>) {
        let Some(stems) = &self.svsep_stems else {
            return;
        };
        let directory = stems.vocals.parent().unwrap_or_else(|| Path::new("."));
        if let Err(error) = open::that(directory) {
            self.svsep_notice = Some(format!("打开目录失败：{error}"));
        }
        cx.notify();
    }

    fn pick_midi_input(&mut self, cx: &mut Context<Self>) {
        const FILTER: &[&str] = &[
            "wav", "mp3", "flac", "m4a", "ogg", "aac", "opus", "wma", "aiff", "ape", "mp4", "mkv",
            "mov", "webm", "avi",
        ];
        let Some(path) = rfd::FileDialog::new()
            .add_filter("Audio / Video", FILTER)
            .pick_file()
        else {
            return;
        };
        self.midi_input = Some(path);
        self.midi_outputs = None;
        self.midi_notice = None;
        cx.notify();
    }

    fn prepare_midi(&mut self, cx: &mut Context<Self>) {
        if self
            .midi_prepare_job
            .is_some_and(|id| self.job_center.read(cx).is_running(id))
        {
            return;
        }
        let s = self.text();
        let job = self
            .job_center
            .read(cx)
            .start(s.midi_prepare, move |ctx| midi::ensure_ready(&ctx));
        self.midi_prepare_job = Some(job.id);
        self.midi_notice = None;
        let job_id = job.id;
        cx.spawn(async move |this, cx| {
            let outcome = job.result.recv().await;
            let Some(this) = this.upgrade() else {
                return;
            };
            this.update(cx, |this, cx| {
                if this.midi_prepare_job == Some(job_id) {
                    this.midi_prepare_job = None;
                }
                match outcome {
                    Ok(JobOutcome::Done(())) => this.midi_notice = None,
                    Ok(JobOutcome::Failed(error)) => this.midi_notice = Some(error),
                    Ok(JobOutcome::Canceled) => {
                        this.midi_notice = Some(this.text().job_canceled.to_string());
                    }
                    Err(_) => this.midi_notice = Some(this.text().job_failed.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn start_midi(&mut self, cx: &mut Context<Self>) {
        if self
            .midi_job
            .is_some_and(|id| self.job_center.read(cx).is_running(id))
        {
            return;
        }
        let Some(input) = self.midi_input.clone() else {
            return;
        };
        let output_dir = input
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let options = MidiOptions {
            steps: self.midi_steps,
            threads: 4,
            device: self.midi_device,
        };
        let s = self.text();
        let job = self.job_center.read(cx).start(s.midi_run, move |ctx| {
            midi::transcribe(&input, &output_dir, &options, &ctx)
        });
        self.midi_job = Some(job.id);
        self.midi_notice = None;
        let job_id = job.id;
        cx.spawn(async move |this, cx| {
            let outcome = job.result.recv().await;
            let Some(this) = this.upgrade() else {
                return;
            };
            this.update(cx, |this, cx| {
                if this.midi_job == Some(job_id) {
                    this.midi_job = None;
                }
                match outcome {
                    Ok(JobOutcome::Done(outputs)) => {
                        this.midi_outputs = Some(outputs);
                        this.midi_notice = Some(this.text().midi_done.to_string());
                    }
                    Ok(JobOutcome::Failed(error)) => this.midi_notice = Some(error),
                    Ok(JobOutcome::Canceled) => {
                        this.midi_notice = Some(this.text().job_canceled.to_string());
                    }
                    Err(_) => this.midi_notice = Some(this.text().job_failed.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn cancel_midi(&mut self, cx: &mut Context<Self>) {
        if let Some(id) = self.midi_job.or(self.midi_prepare_job) {
            self.job_center.read(cx).cancel(id);
            cx.notify();
        }
    }

    fn open_midi_folder(&mut self, cx: &mut Context<Self>) {
        let Some(outputs) = &self.midi_outputs else {
            return;
        };
        let directory = outputs.midi.parent().unwrap_or_else(|| Path::new("."));
        if let Err(error) = open::that(directory) {
            self.midi_notice = Some(format!("打开目录失败：{error}"));
        }
        cx.notify();
    }

    fn set_midi_steps(&mut self, steps: usize, cx: &mut Context<Self>) {
        self.midi_steps = steps;
        cx.notify();
    }

    fn set_midi_device(&mut self, device: MidiDevice, cx: &mut Context<Self>) {
        self.midi_device = device;
        cx.notify();
    }

    fn open_directory(&mut self, directory: PathBuf, cx: &mut Context<Self>) {
        let result = std::fs::create_dir_all(&directory).and_then(|_| open::that(&directory));
        if let Err(error) = result {
            self.notice = Some(format!("打开目录失败：{error}"));
        }
        cx.notify();
    }

    fn open_output_dir(&mut self, cx: &mut Context<Self>) {
        let value = self.output_input.read(cx).value().trim().to_string();
        if value.is_empty() {
            return;
        }
        self.open_directory(PathBuf::from(value), cx);
    }

    fn open_download_dir(&mut self, cx: &mut Context<Self>) {
        let directory = self.download_directory(cx);
        self.open_directory(directory, cx);
    }

    fn open_ext_dir(&mut self, cx: &mut Context<Self>) {
        let value = self.ext_input.read(cx).value().trim().to_string();
        let directory = if value.is_empty() {
            crate::config::extensions_root()
        } else {
            PathBuf::from(value)
        };
        self.open_directory(directory, cx);
    }

    fn open_tools_dir(&mut self, cx: &mut Context<Self>) {
        self.open_directory(crate::config::tools_dir(), cx);
    }

    fn open_data_dir(&mut self, cx: &mut Context<Self>) {
        self.open_directory(crate::config::data_dir(), cx);
    }

    fn open_logs_dir(&mut self, cx: &mut Context<Self>) {
        self.open_directory(crate::config::logs_dir(), cx);
    }

    fn download_directory(&self, cx: &mut Context<Self>) -> PathBuf {
        let value = self.download_input.read(cx).value().trim().to_string();
        if value.is_empty() {
            default_download_dir()
        } else {
            PathBuf::from(value)
        }
    }

    pub fn watch_system_theme(&self, window: &mut Window, cx: &mut Context<Self>) {
        cx.observe_window_appearance(window, |this, window, cx| {
            if this.config.theme == ThemePreference::System {
                apply_theme(ThemePreference::System, window, cx);
                cx.notify();
            }
        })
        .detach();
    }

    fn set_theme(
        &mut self,
        preference: ThemePreference,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        apply_theme(preference, window, cx);
        self.config.theme = preference;
        self.notice = self.config.save().err();
        cx.notify();
    }

    fn set_language(&mut self, language: Language, cx: &mut Context<Self>) {
        self.config.language = language;
        self.notice = self.config.save().err();
        cx.notify();
    }

    fn render_title_bar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let primary = theme.primary;
        let primary_foreground = theme.primary_foreground;
        let muted = theme.muted_foreground;
        let radius = theme.radius;

        TitleBar::new().child(
            div()
                .flex()
                .items_center()
                .gap_2()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_center()
                        .w(px(24.))
                        .h(px(24.))
                        .rounded(radius)
                        .bg(primary)
                        .text_color(primary_foreground)
                        .text_sm()
                        .font_weight(FontWeight::BOLD)
                        .child("V"),
                )
                .child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child("V-Synth-Studio"),
                )
                .child(div().text_xs().text_color(muted).child("GPUI preview")),
        )
    }

    fn render_sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let sidebar = theme.sidebar;
        let foreground = theme.sidebar_foreground;
        let border = theme.sidebar_border;
        let muted = theme.sidebar_foreground.opacity(0.62);
        let accent = theme.sidebar_accent;
        let accent_foreground = theme.sidebar_accent_foreground;
        let radius = theme.radius;
        let s = self.text();

        let mut items = Vec::new();
        let mut last_group = "";
        for page in Page::ALL {
            if page.group(s) != last_group {
                last_group = page.group(s);
                items.push(
                    div()
                        .pt_3()
                        .pb_1()
                        .px_2()
                        .text_xs()
                        .text_color(muted)
                        .child(page.group(s))
                        .into_any_element(),
                );
            }
            items.push(
                self.render_nav_item(page, foreground, accent, accent_foreground, radius, cx)
                    .into_any_element(),
            );
        }

        let theme_buttons = ThemePreference::ALL
            .into_iter()
            .map(|preference| self.render_theme_button(preference, true, cx))
            .collect::<Vec<_>>();

        v_flex()
            .w(px(SIDEBAR_WIDTH))
            .h_full()
            .flex_shrink_0()
            .bg(sidebar)
            .text_color(foreground)
            .border_r_1()
            .border_color(border)
            .child(
                v_flex()
                    .id("sidebar-nav")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px_3()
                    .pb_3()
                    .gap_1()
                    .children(items),
            )
            .child(
                v_flex()
                    .p_3()
                    .gap_2()
                    .border_t_1()
                    .border_color(border)
                    .child(div().text_xs().text_color(muted).child(s.theme))
                    .child(h_flex().gap_1().children(theme_buttons)),
            )
    }

    fn render_nav_item(
        &self,
        page: Page,
        foreground: Hsla,
        accent: Hsla,
        accent_foreground: Hsla,
        radius: Pixels,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let entity = cx.entity();
        let active = self.page == page;
        let row = div()
            .id(SharedString::from(format!("nav-{}", page.id())))
            .flex()
            .items_center()
            .gap_2()
            .h(px(36.))
            .px_2()
            .rounded(radius)
            .cursor_pointer()
            .text_color(foreground)
            .child(Icon::new(page.icon()).w(px(16.)).h(px(16.)))
            .child(div().text_sm().child(page.title(self.text())));

        let row = if active {
            row.bg(accent).text_color(accent_foreground)
        } else {
            row.hover(move |style| style.bg(accent.opacity(0.55)))
        };

        row.on_click(move |_, window, cx| {
            entity.update(cx, |this, cx| this.set_page(page, window, cx));
        })
    }

    fn render_theme_button(
        &self,
        preference: ThemePreference,
        compact: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let entity = cx.entity();
        let selected = self.config.theme == preference;
        let scope = if compact { "sidebar" } else { "page" };
        let id = SharedString::from(format!("theme-{scope}-{}", preference.key()));
        let label = theme_label(preference, self.text());

        let mut button = Button::new(id).label(label);
        if compact {
            button = button.compact();
        }
        button = if selected {
            button.primary()
        } else {
            button.ghost()
        };
        button
            .on_click(move |_, window, cx| {
                entity.update(cx, |this, cx| this.set_theme(preference, window, cx));
            })
            .into_any_element()
    }

    fn render_main(&self, cx: &mut Context<Self>) -> AnyElement {
        if self.page == Page::Pv || self.page == Page::Video && self.video_webview.is_some() {
            return v_flex()
                .flex_1()
                .min_w_0()
                .h_full()
                .child(self.render_page(cx))
                .into_any_element();
        }

        let theme = cx.theme();
        let danger = theme.danger;
        let radius = theme.radius;

        let mut main = v_flex()
            .id("main-scroll")
            .flex_1()
            .min_w_0()
            .h_full()
            .overflow_y_scroll()
            .p_6()
            .gap_4();

        if let Some(notice) = &self.notice {
            main = main.child(
                div()
                    .w_full()
                    .p_3()
                    .rounded(radius)
                    .bg(danger.opacity(0.12))
                    .text_color(danger)
                    .text_sm()
                    .child(notice.clone()),
            );
        }

        main.child(self.render_page(cx)).into_any_element()
    }

    fn render_page(&self, cx: &mut Context<Self>) -> AnyElement {
        match self.page {
            Page::Dashboard => self.render_dashboard(cx).into_any_element(),
            Page::Convert => self.render_convert(cx),
            Page::Video => self.render_video(cx),
            Page::Audio => self.render_audio(cx),
            Page::Lyrics => self.render_lyrics(cx),
            Page::Svsep => self.render_svsep(cx),
            Page::Midi => self.render_midi(cx),
            Page::Settings => self.render_settings(cx).into_any_element(),
            Page::Resources => self.render_resources(cx).into_any_element(),
            Page::Pv => self.render_pv(cx),
        }
    }

    fn render_pv(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let muted = theme.muted_foreground;
        let danger = theme.danger;
        let border = theme.border;
        let radius = theme.radius;
        let entity = cx.entity();
        let s = self.text();
        let status = self
            .pv_status
            .clone()
            .unwrap_or_else(|| s.pv_loading.to_string());
        let init_entity = entity.clone();

        let body = if let Some(error) = &self.webview_error {
            callout(error, danger, radius).into_any_element()
        } else if let Some(webview) = &self.webview {
            div()
                .flex_1()
                .min_h_0()
                .w_full()
                .rounded(radius)
                .border_1()
                .border_color(border)
                .overflow_hidden()
                .child(webview.clone())
                .into_any_element()
        } else {
            h_flex()
                .child(
                    Button::new("pv-init")
                        .label(self.text().open_editor)
                        .primary()
                        .on_click(move |_, window, cx| {
                            init_entity.update(cx, |this, cx| this.ensure_webview(window, cx));
                        }),
                )
                .into_any_element()
        };

        let go_lyrics_entity = entity.clone();
        let import_entity = entity.clone();
        let mut toolbar = h_flex()
            .items_center()
            .gap_2()
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .text_xs()
                    .text_color(muted)
                    .child(status),
            )
            .child(
                Button::new("pv-go-lyrics")
                    .label(s.pv_go_lyrics)
                    .compact()
                    .on_click(move |_, window, cx| {
                        go_lyrics_entity.update(cx, |this, cx| {
                            this.set_page(Page::Lyrics, window, cx);
                        });
                    }),
            )
            .child(
                Button::new("pv-import-lyrics")
                    .label(s.pv_import_lyrics)
                    .compact()
                    .on_click(move |_, _, cx| {
                        import_entity.update(cx, |this, cx| this.import_pv_lyrics(cx));
                    }),
            );
        if self.pv_ready && self.pv_pending_lyrics.is_some() {
            let reinject_entity = entity.clone();
            toolbar = toolbar.child(
                Button::new("pv-reinject")
                    .label(s.pv_reinject)
                    .compact()
                    .on_click(move |_, _, cx| {
                        reinject_entity.update(cx, |this, cx| {
                            this.pv_injected = None;
                            this.inject_pv_lyrics(cx);
                        });
                    }),
            );
        }
        if self.pv_export_dir.is_some() {
            let open_entity = entity.clone();
            toolbar = toolbar.child(
                Button::new("pv-open-export")
                    .label(s.pv_open_export)
                    .compact()
                    .on_click(move |_, _, cx| {
                        open_entity.update(cx, |this, cx| this.open_pv_export_dir(cx));
                    }),
            );
        }

        let mut page =
            v_flex()
                .size_full()
                .p_6()
                .gap_3()
                .child(page_header(self.page, muted, self.text()));
        if let Some(source) = self.webview_source.clone() {
            page = page.child(div().text_xs().text_color(muted).child(source));
        }
        page.child(toolbar).child(body).into_any_element()
    }

    pub fn refresh_announcements(&mut self, cx: &mut Context<Self>) {
        if self.announce_loading {
            return;
        }
        self.announce_loading = true;
        self.announce_error = None;
        cx.notify();
        let (sender, receiver) = async_channel::bounded(1);
        std::thread::spawn(move || {
            let _ = sender.send_blocking(announce::fetch());
        });
        cx.spawn(async move |this, cx| {
            let result = receiver.recv().await;
            let _ = this.update(cx, |this, cx| {
                this.announce_loading = false;
                match result {
                    Ok(Ok(items)) => {
                        this.announcements = Some(items);
                        this.announce_error = None;
                    }
                    Ok(Err(error)) => this.announce_error = Some(error),
                    Err(_) => this.announce_error = Some(this.text().announce_failed.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn mark_announcement_seen(&mut self, id: &str, cx: &mut Context<Self>) {
        self.config.mark_announcement_seen(id);
        self.notice = self
            .config
            .save()
            .err()
            .map(|error| format!("{}：{error}", self.text().announce_read_failed));
        cx.notify();
    }

    fn mark_all_announcements_seen(&mut self, cx: &mut Context<Self>) {
        let Some(items) = self.announcements.clone() else {
            return;
        };
        for item in items {
            self.config.mark_announcement_seen(&item.id);
        }
        self.notice = self
            .config
            .save()
            .err()
            .map(|error| format!("{}：{error}", self.text().announce_read_failed));
        cx.notify();
    }

    fn render_announcements(&self, cx: &mut Context<Self>, limit: usize) -> AnyElement {
        let theme = cx.theme();
        let muted = theme.muted_foreground;
        let entity = cx.entity();
        let s = self.text();
        let unread = self.announcements.as_ref().is_some_and(|items| {
            items
                .iter()
                .any(|item| !self.config.announcement_seen(&item.id))
        });
        let refresh_entity = entity.clone();
        let all_entity = entity.clone();
        let mut buttons = h_flex().gap_2().child(
            Button::new("announce-refresh")
                .label(s.announce_refresh)
                .compact()
                .disabled(self.announce_loading)
                .on_click(move |_, _, cx| {
                    refresh_entity.update(cx, |this, cx| this.refresh_announcements(cx));
                }),
        );
        if unread {
            buttons = buttons.child(
                Button::new("announce-mark-all")
                    .label(s.announce_mark_all)
                    .compact()
                    .on_click(move |_, _, cx| {
                        all_entity.update(cx, |this, cx| this.mark_all_announcements_seen(cx));
                    }),
            );
        }

        let body = if self.announce_loading {
            div()
                .text_sm()
                .text_color(muted)
                .child(s.announce_loading)
                .into_any_element()
        } else if let Some(error) = &self.announce_error {
            div()
                .text_sm()
                .text_color(theme.danger)
                .child(format!("{}：{error}", s.announce_failed))
                .into_any_element()
        } else if let Some(items) = &self.announcements {
            if items.is_empty() {
                div()
                    .text_sm()
                    .text_color(muted)
                    .child(s.announce_empty)
                    .into_any_element()
            } else {
                let mut rows = v_flex().gap_3();
                for item in items.iter().take(limit) {
                    let color = match item.level.as_str() {
                        "warn" => theme.warning,
                        "critical" => theme.danger,
                        _ => theme.primary,
                    };
                    let level = match item.level.as_str() {
                        "warn" => s.announce_warn,
                        "critical" => s.announce_critical,
                        _ => s.announce_info,
                    };
                    let is_unread = !self.config.announcement_seen(&item.id);
                    let mark_entity = entity.clone();
                    let id = item.id.clone();
                    let date = item.date.split(['T', ' ']).next().unwrap_or("");
                    let mut header = h_flex()
                        .items_center()
                        .gap_2()
                        .child(
                            div()
                                .text_sm()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(item.title.clone()),
                        )
                        .child(announce_badge(level, color, theme.radius));
                    if !date.is_empty() {
                        header =
                            header.child(div().text_xs().text_color(muted).child(date.to_string()));
                    }
                    if is_unread {
                        header = header
                            .child(announce_badge(
                                s.announce_unread,
                                theme.primary,
                                theme.radius,
                            ))
                            .child(
                                Button::new(SharedString::from(format!(
                                    "announce-read-{}",
                                    item.id
                                )))
                                .label(s.announce_mark_read)
                                .compact()
                                .on_click(move |_, _, cx| {
                                    mark_entity.update(cx, |this, cx| {
                                        this.mark_announcement_seen(&id, cx);
                                    });
                                }),
                            );
                    }
                    rows = rows.child(
                        v_flex()
                            .gap_1()
                            .child(header)
                            .child(div().text_sm().child(item.body.clone())),
                    );
                }
                rows.into_any_element()
            }
        } else {
            div()
                .text_sm()
                .text_color(muted)
                .child(s.announce_none_yet)
                .into_any_element()
        };

        GroupBox::new()
            .id("announcements")
            .outline()
            .title(s.announcements)
            .child(v_flex().gap_3().child(buttons).child(body))
            .into_any_element()
    }

    fn check_updates(&mut self, cx: &mut Context<Self>) {
        if self.update_checking {
            return;
        }
        self.update_checking = true;
        self.update_info = None;
        self.update_error = None;
        self.update_notice = None;
        self.update_file = None;
        cx.notify();
        let (sender, receiver) = async_channel::bounded(1);
        std::thread::spawn(move || {
            let _ = sender.send_blocking(update::check());
        });
        cx.spawn(async move |this, cx| {
            let result = receiver.recv().await;
            let _ = this.update(cx, |this, cx| {
                this.update_checking = false;
                match result {
                    Ok(Ok(Some(info))) => this.update_info = Some(info),
                    Ok(Ok(None)) => {
                        this.update_notice = Some(this.text().up_to_date.to_string());
                    }
                    Ok(Err(error)) => this.update_error = Some(error),
                    Err(_) => {
                        this.update_error = Some(this.text().update_failed.to_string());
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn download_update(&mut self, cx: &mut Context<Self>) {
        if self
            .update_job
            .is_some_and(|id| self.job_center.read(cx).is_running(id))
        {
            return;
        }
        let Some(info) = self.update_info.clone() else {
            return;
        };
        let s = self.text();
        let job = self
            .job_center
            .read(cx)
            .start(s.download_update, move |ctx| update::download(&info, &ctx));
        self.update_job = Some(job.id);
        self.update_error = None;
        self.update_notice = None;
        let job_id = job.id;
        cx.spawn(async move |this, cx| {
            let outcome = job.result.recv().await;
            let Some(this) = this.upgrade() else {
                return;
            };
            this.update(cx, |this, cx| {
                if this.update_job == Some(job_id) {
                    this.update_job = None;
                }
                match outcome {
                    Ok(JobOutcome::Done(path)) => {
                        this.update_file = Some(path);
                        this.update_notice = Some(this.text().update_downloaded.to_string());
                    }
                    Ok(JobOutcome::Failed(error)) => this.update_error = Some(error),
                    Ok(JobOutcome::Canceled) => {
                        this.update_notice = Some(this.text().job_canceled.to_string());
                    }
                    Err(_) => this.update_error = Some(this.text().update_failed.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn install_update(&mut self, cx: &mut Context<Self>) {
        let Some(path) = self.update_file.clone() else {
            return;
        };
        if !update::is_installed() {
            if let Some(parent) = path.parent() {
                self.open_directory(parent.to_path_buf(), cx);
            }
            self.update_notice = Some(self.text().update_portable.to_string());
            cx.notify();
            return;
        }
        match update::launch_installer(&path) {
            Ok(()) => {
                crate::logging::line(&format!("launching update installer {}", path.display()));
                self.update_notice = Some(self.text().update_install_soon.to_string());
                cx.notify();
                std::process::exit(0);
            }
            Err(error) => {
                self.update_error = Some(error);
                cx.notify();
            }
        }
    }

    fn open_update_folder(&mut self, cx: &mut Context<Self>) {
        let Some(path) = self.update_file.clone() else {
            return;
        };
        if let Some(parent) = path.parent() {
            self.open_directory(parent.to_path_buf(), cx);
        }
    }

    fn render_updates(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let muted = theme.muted_foreground;
        let border = theme.border;
        let entity = cx.entity();
        let s = self.text();
        let snapshot = self
            .update_job
            .and_then(|id| self.job_center.read(cx).snapshot(id));
        let job_running = snapshot
            .as_ref()
            .is_some_and(|snap| snap.status.is_running());
        let checking = self.update_checking;

        let check_entity = entity.clone();
        let buttons = h_flex().gap_2().child(
            Button::new("update-check")
                .label(s.check_updates)
                .compact()
                .disabled(checking)
                .on_click(move |_, _, cx| {
                    check_entity.update(cx, |this, cx| this.check_updates(cx));
                }),
        );

        let body = if checking {
            div()
                .text_sm()
                .text_color(muted)
                .child(s.checking_updates)
                .into_any_element()
        } else if let Some(error) = &self.update_error {
            div()
                .text_sm()
                .text_color(theme.danger)
                .child(format!("{}：{error}", s.update_failed))
                .into_any_element()
        } else if let Some(info) = &self.update_info {
            let download_entity = entity.clone();
            let install_entity = entity.clone();
            let mut update_buttons = h_flex().gap_2();
            if self.update_file.is_none() {
                update_buttons = update_buttons.child(
                    Button::new("update-download")
                        .label(s.download_update)
                        .compact()
                        .disabled(job_running)
                        .on_click(move |_, _, cx| {
                            download_entity.update(cx, |this, cx| this.download_update(cx));
                        }),
                );
            } else if update::is_installed() {
                update_buttons = update_buttons.child(
                    Button::new("update-install")
                        .label(s.install_update)
                        .primary()
                        .compact()
                        .on_click(move |_, _, cx| {
                            install_entity.update(cx, |this, cx| this.install_update(cx));
                        }),
                );
            } else {
                let open_entity = entity.clone();
                update_buttons = update_buttons.child(
                    Button::new("update-open-folder")
                        .label(s.open_update_folder)
                        .compact()
                        .on_click(move |_, _, cx| {
                            open_entity.update(cx, |this, cx| this.open_update_folder(cx));
                        }),
                );
            }
            let mut details = v_flex().gap_1().child(
                div()
                    .text_sm()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(format!("{}：{}", s.update_available, info.version)),
            );
            if !info.published.is_empty() {
                details = details.child(div().text_xs().text_color(muted).child(format!(
                    "{}: {}",
                    s.published_at,
                    info.published.split('T').next().unwrap_or("")
                )));
            }
            details = details.child(div().text_sm().child(if info.changelog.is_empty() {
                s.update_no_changelog.to_string()
            } else {
                info.changelog.clone()
            }));
            if let Some(path) = &self.update_file {
                details = details.child(
                    div()
                        .text_xs()
                        .text_color(muted)
                        .child(path.display().to_string()),
                );
            }
            if !update::is_installed() && self.update_file.is_some() {
                details = details.child(div().text_xs().text_color(muted).child(s.update_portable));
            }
            details.child(update_buttons).into_any_element()
        } else if let Some(notice) = &self.update_notice {
            div()
                .text_sm()
                .text_color(muted)
                .child(notice.clone())
                .into_any_element()
        } else {
            div()
                .text_xs()
                .text_color(muted)
                .child(s.update_hint)
                .into_any_element()
        };

        let progress = snapshot
            .filter(|snap| snap.status.is_running())
            .map(|snap| {
                div()
                    .text_xs()
                    .text_color(muted)
                    .child(format!("{} {}", s.downloading_update, snap.message))
            });

        GroupBox::new()
            .id("settings-updates")
            .outline()
            .title(s.updates)
            .child(
                v_flex()
                    .gap_2()
                    .child(info_row(
                        s.current_version,
                        env!("CARGO_PKG_VERSION").to_string(),
                        muted,
                        border,
                    ))
                    .child(buttons)
                    .child(body)
                    .children(progress),
            )
            .into_any_element()
    }

    fn render_dashboard(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let announcements = self.render_announcements(cx, 5);
        let jobs = self.job_center.read(cx).snapshots().to_vec();
        let theme = cx.theme();
        let muted = theme.muted_foreground;
        let border = theme.border;
        let entity = cx.entity();
        let s = self.text();

        let svsep_status = svsep::status();
        let midi_status = midi::status();
        let dependencies_ready = ALL_DEPENDENCIES
            .iter()
            .filter(|id| self.dependency_status(**id).ready)
            .count();
        let packs_group = GroupBox::new()
            .id("dashboard-packs")
            .outline()
            .title(s.packs)
            .child(
                v_flex()
                    .gap_2()
                    .child(pack_row(
                        s.page_svsep,
                        "UVR-MDX-NET-Inst_HQ_3".to_string(),
                        svsep_status.runtime_ready && svsep_status.model_ready,
                        Page::Svsep,
                        entity.clone(),
                        theme,
                        s,
                    ))
                    .child(pack_row(
                        s.page_midi,
                        "GAME 1.0.3 large (ONNX)".to_string(),
                        midi_status.runtime_ready && midi_status.models_ready,
                        Page::Midi,
                        entity.clone(),
                        theme,
                        s,
                    )),
            );

        let jobs_element = jobs_panel(&jobs, self.job_center.clone(), theme, s);
        let quick_buttons = Page::ALL
            .into_iter()
            .filter(|page| !matches!(page, Page::Dashboard | Page::Settings))
            .map(|page| {
                let entity = entity.clone();
                Button::new(SharedString::from(format!("quick-{}", page.id())))
                    .label(page.title(self.text()))
                    .on_click(move |_, window, cx| {
                        entity.update(cx, |this, cx| this.set_page(page, window, cx));
                    })
                    .into_any_element()
            })
            .collect::<Vec<_>>();

        v_flex()
            .gap_4()
            .child(page_header(self.page, muted, self.text()))
            .child(announcements)
            .child(
                GroupBox::new()
                    .id("dashboard-runtime")
                    .outline()
                    .title(s.runtime)
                    .child(
                        v_flex()
                            .gap_1()
                            .child(info_row(
                                s.version,
                                env!("CARGO_PKG_VERSION").to_string(),
                                muted,
                                border,
                            ))
                            .child(info_row(
                                s.platform,
                                format!("{} / {}", std::env::consts::OS, std::env::consts::ARCH),
                                muted,
                                border,
                            ))
                            .child(info_row(
                                s.config_file,
                                config_path_display(),
                                muted,
                                border,
                            ))
                            .child(info_row(
                                s.theme,
                                theme_label(self.config.theme, s).to_string(),
                                muted,
                                border,
                            ))
                            .child(info_row(
                                s.framework,
                                "gpui-kit 0.8".to_string(),
                                muted,
                                border,
                            ))
                            .child(info_row(
                                s.dependencies,
                                format!("{dependencies_ready}/6 {}", s.ready),
                                muted,
                                border,
                            )),
                    ),
            )
            .child(jobs_element)
            .child(packs_group)
            .child(
                GroupBox::new()
                    .id("dashboard-quick")
                    .title(s.quick_entry)
                    .child(h_flex().gap_2().flex_wrap().children(quick_buttons)),
            )
    }

    fn render_svsep(&self, cx: &mut Context<Self>) -> AnyElement {
        let dependency_panel = self.render_dependencies(
            &[
                DependencyId::Ffmpeg,
                DependencyId::Python,
                DependencyId::UvrModel,
            ],
            cx,
            false,
        );
        let theme = cx.theme();
        let muted = theme.muted_foreground;
        let border = theme.border;
        let primary = theme.primary;
        let entity = cx.entity();
        let s = self.text();
        let status = svsep::status();

        let prepare_running = self
            .svsep_prepare_job
            .is_some_and(|id| self.job_center.read(cx).is_running(id));
        let run_running = self
            .svsep_job
            .is_some_and(|id| self.job_center.read(cx).is_running(id));
        let active_job = self.svsep_job.or(self.svsep_prepare_job);
        let snapshot = active_job.and_then(|id| self.job_center.read(cx).snapshot(id));

        let input_block = if let Some(input) = &self.svsep_input {
            v_flex()
                .gap_1()
                .child(div().text_sm().child(input.display().to_string()))
                .into_any_element()
        } else {
            div()
                .text_sm()
                .text_color(muted)
                .child(s.svsep_no_input)
                .into_any_element()
        };
        let pick_entity = entity.clone();
        let pick_button = Button::new("svsep-pick")
            .label(s.svsep_pick)
            .primary()
            .on_click(move |_, _, cx| {
                pick_entity.update(cx, |this, cx| this.pick_svsep_input(cx));
            });

        let prepare_entity = entity.clone();
        let prepare_button = Button::new("svsep-prepare")
            .label(if prepare_running {
                s.svsep_preparing
            } else {
                s.svsep_prepare
            })
            .on_click(move |_, _, cx| {
                prepare_entity.update(cx, |this, cx| this.prepare_svsep(cx));
            });
        let engine_status = if status.runtime_ready && status.model_ready {
            s.svsep_runtime_ready
        } else {
            s.svsep_runtime_missing
        };

        let run_entity = entity.clone();
        let cancel_entity = entity.clone();
        let action_button = if run_running || prepare_running {
            Button::new("svsep-cancel")
                .label(s.svsep_cancel)
                .on_click(move |_, _, cx| {
                    cancel_entity.update(cx, |this, cx| this.cancel_svsep(cx));
                })
                .into_any_element()
        } else if status.runtime_ready && status.model_ready {
            Button::new("svsep-run")
                .label(s.svsep_run)
                .primary()
                .disabled(self.svsep_input.is_none())
                .on_click(move |_, _, cx| {
                    run_entity.update(cx, |this, cx| this.start_svsep(cx));
                })
                .into_any_element()
        } else {
            prepare_button.into_any_element()
        };

        let stems_block = self.svsep_stems.as_ref().map(|stems| {
            let open_entity = entity.clone();
            v_flex()
                .gap_1()
                .child(div().text_sm().child(format!(
                    "{}: {}",
                    s.svsep_vocals,
                    stems.vocals.display()
                )))
                .child(div().text_sm().child(format!(
                    "{}: {}",
                    s.svsep_instrumental,
                    stems.instrumental.display()
                )))
                .child(
                    Button::new("svsep-open-folder")
                        .label(s.svsep_open_folder)
                        .on_click(move |_, _, cx| {
                            open_entity.update(cx, |this, cx| this.open_svsep_folder(cx));
                        }),
                )
                .into_any_element()
        });

        let progress_block = if let Some(snapshot) = &snapshot {
            if snapshot.status.is_running() {
                v_flex()
                    .gap_1()
                    .child(div().text_xs().text_color(muted).child(s.svsep_running))
                    .child(
                        div()
                            .text_xs()
                            .text_color(muted)
                            .child(snapshot.message.clone()),
                    )
                    .child(
                        div().h(px(4.)).w_full().rounded(px(2.)).bg(border).child(
                            div()
                                .h_full()
                                .w(relative(snapshot.progress.unwrap_or(0.0)))
                                .rounded(px(2.))
                                .bg(primary),
                        ),
                    )
                    .into_any_element()
            } else {
                div().into_any_element()
            }
        } else {
            div().into_any_element()
        };
        let notice = self.svsep_notice.as_ref().map(|notice| {
            div()
                .text_sm()
                .text_color(muted)
                .child(notice.clone())
                .into_any_element()
        });

        v_flex()
            .gap_4()
            .child(page_header(self.page, muted, s))
            .child(dependency_panel)
            .child(
                GroupBox::new()
                    .id("svsep-engine")
                    .outline()
                    .title(s.svsep_engine)
                    .child(
                        v_flex()
                            .gap_2()
                            .child(meta_text(
                                s.svsep_model,
                                "UVR-MDX-NET-Inst_HQ_3".to_string(),
                                muted,
                            ))
                            .child(div().text_sm().child(engine_status))
                            .child(div().text_xs().text_color(muted).child(s.svsep_hint)),
                    ),
            )
            .child(
                GroupBox::new()
                    .id("svsep-input")
                    .outline()
                    .title(s.svsep_input)
                    .child(v_flex().gap_2().child(input_block).child(pick_button)),
            )
            .child(
                GroupBox::new()
                    .id("svsep-actions")
                    .outline()
                    .title(s.svsep_run)
                    .child(
                        v_flex()
                            .gap_2()
                            .child(action_button)
                            .child(progress_block)
                            .children(notice)
                            .children(stems_block),
                    ),
            )
            .into_any_element()
    }

    fn render_midi(&self, cx: &mut Context<Self>) -> AnyElement {
        let dependency_panel = self.render_dependencies(
            &[
                DependencyId::Ffmpeg,
                DependencyId::Python,
                DependencyId::GameModel,
            ],
            cx,
            false,
        );
        let theme = cx.theme();
        let muted = theme.muted_foreground;
        let border = theme.border;
        let primary = theme.primary;
        let entity = cx.entity();
        let s = self.text();
        let status = midi::status();

        let prepare_running = self
            .midi_prepare_job
            .is_some_and(|id| self.job_center.read(cx).is_running(id));
        let run_running = self
            .midi_job
            .is_some_and(|id| self.job_center.read(cx).is_running(id));
        let active_job = self.midi_job.or(self.midi_prepare_job);
        let snapshot = active_job.and_then(|id| self.job_center.read(cx).snapshot(id));
        let ready = status.runtime_ready && status.models_ready;

        let input_block = if let Some(input) = &self.midi_input {
            v_flex()
                .gap_1()
                .child(div().text_sm().child(input.display().to_string()))
                .into_any_element()
        } else {
            div()
                .text_sm()
                .text_color(muted)
                .child(s.midi_no_input)
                .into_any_element()
        };
        let pick_entity = entity.clone();
        let pick_button = Button::new("midi-pick")
            .label(s.midi_pick)
            .primary()
            .on_click(move |_, _, cx| {
                pick_entity.update(cx, |this, cx| this.pick_midi_input(cx));
            });

        let prepare_entity = entity.clone();
        let prepare_button = Button::new("midi-prepare")
            .label(if prepare_running {
                s.midi_preparing
            } else {
                s.midi_prepare
            })
            .on_click(move |_, _, cx| {
                prepare_entity.update(cx, |this, cx| this.prepare_midi(cx));
            });

        let run_entity = entity.clone();
        let cancel_entity = entity.clone();
        let action_button = if run_running || prepare_running {
            Button::new("midi-cancel")
                .label(s.midi_cancel)
                .on_click(move |_, _, cx| {
                    cancel_entity.update(cx, |this, cx| this.cancel_midi(cx));
                })
                .into_any_element()
        } else if ready {
            Button::new("midi-run")
                .label(s.midi_run)
                .primary()
                .disabled(self.midi_input.is_none())
                .on_click(move |_, _, cx| {
                    run_entity.update(cx, |this, cx| this.start_midi(cx));
                })
                .into_any_element()
        } else {
            prepare_button.into_any_element()
        };

        let step_buttons = [4usize, 8, 16, 32]
            .into_iter()
            .map(|steps| {
                let entity = entity.clone();
                let selected = self.midi_steps == steps;
                let button = Button::new(SharedString::from(format!("midi-step-{steps}")))
                    .label(steps.to_string())
                    .compact();
                let button = if selected {
                    button.primary()
                } else {
                    button.ghost()
                };
                button
                    .on_click(move |_, _, cx| {
                        entity.update(cx, |this, cx| this.set_midi_steps(steps, cx));
                    })
                    .into_any_element()
            })
            .collect::<Vec<_>>();

        let device_buttons = [
            (MidiDevice::Auto, s.midi_auto),
            (MidiDevice::Cpu, s.midi_cpu),
            (MidiDevice::Gpu, s.midi_gpu),
        ]
        .into_iter()
        .map(|(device, label)| {
            let entity = entity.clone();
            let selected = self.midi_device == device;
            let button = Button::new(SharedString::from(format!("midi-device-{}", device.key())))
                .label(label)
                .compact();
            let button = if selected {
                button.primary()
            } else {
                button.ghost()
            };
            button
                .on_click(move |_, _, cx| {
                    entity.update(cx, |this, cx| this.set_midi_device(device, cx));
                })
                .into_any_element()
        })
        .collect::<Vec<_>>();

        let engine_status = if ready { s.midi_ready } else { s.midi_missing };

        let outputs_block = self.midi_outputs.as_ref().map(|outputs| {
            let open_entity = entity.clone();
            let mut preview = v_flex().gap_1().child(
                h_flex()
                    .gap_2()
                    .text_xs()
                    .text_color(muted)
                    .child(div().w(px(64.)).child(s.midi_onset))
                    .child(div().w(px(64.)).child(s.midi_duration))
                    .child(div().w(px(96.)).child(s.midi_pitch)),
            );
            for note in outputs.preview.iter().take(40) {
                preview = preview.child(
                    h_flex()
                        .gap_2()
                        .text_sm()
                        .child(div().w(px(64.)).child(format!("{:.2}s", note.onset)))
                        .child(
                            div()
                                .w(px(64.))
                                .child(format!("{:.2}s", note.offset - note.onset)),
                        )
                        .child(div().w(px(96.)).child(format!(
                            "{} ({})",
                            note_name(note.pitch),
                            note.pitch.round() as i32
                        ))),
                );
            }
            v_flex()
                .gap_2()
                .child(div().text_sm().child(s.midi_outputs))
                .child(div().text_sm().child(format!(
                    "{}: {}/{}",
                    s.midi_notes,
                    outputs.preview.len(),
                    outputs.notes
                )))
                .child(
                    div()
                        .text_sm()
                        .child(format!("{}: {}", s.midi_backend, outputs.backend)),
                )
                .child(
                    div()
                        .text_sm()
                        .child(format!("{}: {:.1}s", s.midi_seconds, outputs.seconds)),
                )
                .child(div().text_sm().child(outputs.midi.display().to_string()))
                .child(div().text_sm().child(outputs.csv.display().to_string()))
                .child(div().text_sm().child(outputs.json.display().to_string()))
                .child(preview)
                .child(
                    Button::new("midi-open-folder")
                        .label(s.midi_open_folder)
                        .on_click(move |_, _, cx| {
                            open_entity.update(cx, |this, cx| this.open_midi_folder(cx));
                        }),
                )
                .into_any_element()
        });

        let progress_block = if let Some(snapshot) = &snapshot {
            if snapshot.status.is_running() {
                v_flex()
                    .gap_1()
                    .child(div().text_xs().text_color(muted).child(s.midi_running))
                    .child(
                        div()
                            .text_xs()
                            .text_color(muted)
                            .child(snapshot.message.clone()),
                    )
                    .child(
                        div().h(px(4.)).w_full().rounded(px(2.)).bg(border).child(
                            div()
                                .h_full()
                                .w(relative(snapshot.progress.unwrap_or(0.0)))
                                .rounded(px(2.))
                                .bg(primary),
                        ),
                    )
                    .into_any_element()
            } else {
                div().into_any_element()
            }
        } else {
            div().into_any_element()
        };
        let notice = self.midi_notice.as_ref().map(|notice| {
            div()
                .text_sm()
                .text_color(muted)
                .child(notice.clone())
                .into_any_element()
        });

        v_flex()
            .gap_4()
            .child(page_header(self.page, muted, s))
            .child(dependency_panel)
            .child(
                GroupBox::new()
                    .id("midi-engine")
                    .outline()
                    .title(s.midi_engine)
                    .child(
                        v_flex()
                            .gap_2()
                            .child(meta_text(
                                s.midi_model,
                                "GAME 1.0.3 large (ONNX)".to_string(),
                                muted,
                            ))
                            .child(div().text_sm().child(engine_status))
                            .child(div().text_xs().text_color(muted).child(s.midi_license))
                            .child(div().text_xs().text_color(muted).child(s.midi_hint)),
                    ),
            )
            .child(
                GroupBox::new()
                    .id("midi-input")
                    .outline()
                    .title(s.midi_input)
                    .child(v_flex().gap_2().child(input_block).child(pick_button)),
            )
            .child(
                GroupBox::new()
                    .id("midi-options")
                    .outline()
                    .title(s.midi_options)
                    .child(
                        v_flex()
                            .gap_2()
                            .child(
                                h_flex()
                                    .gap_2()
                                    .items_center()
                                    .child(div().text_sm().text_color(muted).child(s.midi_steps))
                                    .children(step_buttons),
                            )
                            .child(
                                h_flex()
                                    .gap_2()
                                    .items_center()
                                    .child(div().text_sm().text_color(muted).child(s.midi_device))
                                    .children(device_buttons),
                            )
                            .child(div().text_xs().text_color(muted).child(s.midi_steps_hint))
                            .child(div().text_xs().text_color(muted).child(s.midi_device_hint)),
                    ),
            )
            .child(
                GroupBox::new()
                    .id("midi-actions")
                    .outline()
                    .title(s.midi_run)
                    .child(
                        v_flex()
                            .gap_2()
                            .child(action_button)
                            .child(progress_block)
                            .children(notice)
                            .children(outputs_block),
                    ),
            )
            .into_any_element()
    }

    fn render_video(&self, cx: &mut Context<Self>) -> AnyElement {
        let dependency_panel =
            self.render_dependencies(&[DependencyId::Ffmpeg, DependencyId::YtDlp], cx, false);
        let theme = cx.theme();
        let muted = theme.muted_foreground;
        let border = theme.border;
        let primary = theme.primary;
        let danger = theme.danger;
        let entity = cx.entity();
        let s = self.text();

        if let Some(webview) = &self.video_webview {
            let close_entity = entity.clone();
            return v_flex()
                .size_full()
                .p_6()
                .gap_3()
                .child(
                    h_flex()
                        .justify_between()
                        .items_center()
                        .child(
                            div()
                                .text_2xl()
                                .font_weight(FontWeight::BOLD)
                                .child(s.video_preview),
                        )
                        .child(
                            Button::new("video-preview-close")
                                .label(s.video_preview_close)
                                .on_click(move |_, _, cx| {
                                    close_entity.update(cx, |this, cx| {
                                        this.close_video_preview(cx);
                                    });
                                }),
                        ),
                )
                .child(
                    div()
                        .flex_1()
                        .min_h_0()
                        .w_full()
                        .rounded(theme.radius)
                        .border_1()
                        .border_color(border)
                        .overflow_hidden()
                        .child(webview.clone()),
                )
                .into_any_element();
        }

        let parsing = self
            .video_parse_job
            .is_some_and(|id| self.job_center.read(cx).is_running(id))
            || self
                .video_page_job
                .is_some_and(|id| self.job_center.read(cx).is_running(id));
        let downloading = self
            .video_download_job
            .is_some_and(|id| self.job_center.read(cx).is_running(id));
        let download_snapshot = self
            .video_download_job
            .and_then(|id| self.job_center.read(cx).snapshot(id));

        let parse_entity = entity.clone();
        let parse_button = Button::new("video-parse")
            .label(if parsing {
                s.video_parsing
            } else {
                s.video_parse
            })
            .primary()
            .on_click(move |_, _, cx| {
                parse_entity.update(cx, |this, cx| this.parse_video(cx));
            });

        let info_block = if let Some(info) = &self.video_info {
            let page = info.pages.get(info.page_index);
            let page_buttons = if info.pages.len() > 1 {
                info.pages
                    .iter()
                    .enumerate()
                    .map(|(index, page)| {
                        let selected = index == info.page_index;
                        let entity = entity.clone();
                        let mut button =
                            Button::new(SharedString::from(format!("video-page-{index}")))
                                .label(format!("P{}", page.page))
                                .compact();
                        button = if selected {
                            button.primary()
                        } else {
                            button.ghost()
                        };
                        button
                            .on_click(move |_, _, cx| {
                                entity.update(cx, |this, cx| {
                                    this.select_video_page(index, cx);
                                });
                            })
                            .into_any_element()
                    })
                    .collect::<Vec<_>>()
            } else {
                Vec::new()
            };
            let quality_buttons = info
                .qualities
                .iter()
                .map(|quality| {
                    let selected = self.video_quality == Some(quality.qn);
                    let entity = entity.clone();
                    let qn = quality.qn;
                    let label = if quality.label.is_empty() {
                        qn.to_string()
                    } else {
                        format!("{} ({qn})", quality.label)
                    };
                    let mut button = Button::new(SharedString::from(format!("video-quality-{qn}")))
                        .label(label)
                        .compact();
                    button = if selected {
                        button.primary()
                    } else {
                        button.ghost()
                    };
                    button
                        .on_click(move |_, _, cx| {
                            entity.update(cx, |this, cx| {
                                this.video_quality = Some(qn);
                                cx.notify();
                            });
                        })
                        .into_any_element()
                })
                .collect::<Vec<_>>();
            let download_entity = entity.clone();
            let cancel_entity = entity.clone();
            let download_button = if downloading {
                Button::new("video-cancel")
                    .label(s.video_cancel)
                    .on_click(move |_, _, cx| {
                        cancel_entity.update(cx, |this, cx| this.cancel_video_download(cx));
                    })
                    .into_any_element()
            } else {
                Button::new("video-download")
                    .label(s.video_download)
                    .primary()
                    .on_click(move |_, _, cx| {
                        download_entity.update(cx, |this, cx| this.download_video(cx));
                    })
                    .into_any_element()
            };
            let page_name = page
                .filter(|_| info.pages.len() > 1)
                .map(|page| {
                    if page.part.is_empty() {
                        format!("P{} · {}", page.page, format_duration(page.duration as f64))
                    } else {
                        format!(
                            "P{} · {} · {}",
                            page.page,
                            page.part,
                            format_duration(page.duration as f64)
                        )
                    }
                })
                .unwrap_or_default();
            let output_entity = entity.clone();
            let output_block = self.video_output.as_ref().map(|output| {
                let open_entity = output_entity.clone();
                let preview_entity = output_entity.clone();
                v_flex()
                    .gap_2()
                    .child(
                        div()
                            .text_xs()
                            .text_color(muted)
                            .child(output.display().to_string()),
                    )
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                Button::new("video-preview")
                                    .label(s.video_preview)
                                    .primary()
                                    .on_click(move |_, window, cx| {
                                        preview_entity.update(cx, |this, cx| {
                                            this.open_video_preview(window, cx);
                                        });
                                    }),
                            )
                            .child(
                                Button::new("video-open-folder")
                                    .label(s.video_open_folder)
                                    .on_click(move |_, _, cx| {
                                        open_entity
                                            .update(cx, |this, cx| this.open_video_folder(cx));
                                    }),
                            ),
                    )
                    .into_any_element()
            });
            v_flex()
                .gap_3()
                .child(
                    div()
                        .text_lg()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(info.title.clone()),
                )
                .child(
                    h_flex()
                        .gap_4()
                        .flex_wrap()
                        .child(meta_text(s.video_owner, info.owner.clone(), muted))
                        .child(meta_text(
                            s.video_duration,
                            format_duration(info.duration as f64),
                            muted,
                        ))
                        .child(meta_text(
                            s.video_pages,
                            info.pages.len().to_string(),
                            muted,
                        )),
                )
                .children(if page_name.is_empty() {
                    None
                } else {
                    Some(div().text_xs().text_color(muted).child(page_name))
                })
                .children(if page_buttons.is_empty() {
                    None
                } else {
                    Some(
                        h_flex()
                            .gap_2()
                            .flex_wrap()
                            .children(page_buttons)
                            .into_any_element(),
                    )
                })
                .child(div().text_xs().text_color(muted).child(s.video_quality))
                .child(h_flex().gap_2().flex_wrap().children(quality_buttons))
                .child(download_button)
                .child(div().text_xs().text_color(muted).child(s.video_output_hint))
                .children(output_block)
                .children(self.video_webview_error.as_ref().map(|error| {
                    div()
                        .text_xs()
                        .text_color(danger)
                        .child(error.clone())
                        .into_any_element()
                }))
                .into_any_element()
        } else {
            div()
                .text_sm()
                .text_color(muted)
                .child(s.video_no_result)
                .into_any_element()
        };

        let progress_block = if let Some(snapshot) = &download_snapshot {
            if snapshot.status.is_running() {
                v_flex()
                    .gap_1()
                    .child(div().text_xs().text_color(muted).child(s.video_downloading))
                    .child(
                        div()
                            .text_xs()
                            .text_color(muted)
                            .child(snapshot.message.clone()),
                    )
                    .child(
                        div().h(px(4.)).w_full().rounded(px(2.)).bg(border).child(
                            div()
                                .h_full()
                                .w(relative(snapshot.progress.unwrap_or(0.0)))
                                .rounded(px(2.))
                                .bg(primary),
                        ),
                    )
                    .into_any_element()
            } else {
                div().into_any_element()
            }
        } else {
            div().into_any_element()
        };
        let notice = self.video_notice.as_ref().map(|notice| {
            div()
                .text_sm()
                .text_color(muted)
                .child(notice.clone())
                .into_any_element()
        });

        v_flex()
            .gap_4()
            .child(page_header(self.page, muted, s))
            .child(dependency_panel)
            .child(
                GroupBox::new()
                    .id("video-url")
                    .outline()
                    .title(s.video_url)
                    .child(
                        v_flex()
                            .gap_2()
                            .child(Input::new(&self.video_url_input).w_full())
                            .child(
                                h_flex().items_center().gap_3().child(parse_button).child(
                                    div().text_xs().text_color(muted).child(s.video_url_hint),
                                ),
                            ),
                    ),
            )
            .child(
                GroupBox::new()
                    .id("video-info")
                    .outline()
                    .title(s.video_info_title)
                    .child(info_block),
            )
            .child(
                GroupBox::new()
                    .id("video-actions")
                    .outline()
                    .title(s.video_download)
                    .child(v_flex().gap_2().child(progress_block).children(notice)),
            )
            .into_any_element()
    }

    fn render_lyrics(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let muted = theme.muted_foreground;
        let border = theme.border;
        let entity = cx.entity();
        let s = self.text();

        let search_entity = entity.clone();
        let search_button = Button::new("lyrics-search")
            .label(s.lyrics_search)
            .primary()
            .on_click(move |_, _, cx| {
                search_entity.update(cx, |this, cx| this.search_lyrics(cx));
            });

        let mut rows = Vec::new();
        for result in &self.lyrics_results {
            let selected = self
                .lyrics_song
                .as_ref()
                .is_some_and(|song| song.id == result.id);
            let id = result.id;
            let select_entity = entity.clone();
            let mut button = Button::new(SharedString::from(format!("lyrics-select-{id}")))
                .label(s.lyrics_select)
                .compact();
            button = if selected {
                button.primary()
            } else {
                button.ghost()
            };
            rows.push(
                h_flex()
                    .justify_between()
                    .items_center()
                    .gap_4()
                    .py_1()
                    .border_b_1()
                    .border_color(border)
                    .child(
                        v_flex()
                            .gap_1()
                            .min_w_0()
                            .child(div().text_sm().child(result.name.clone()))
                            .child(div().text_xs().text_color(muted).child(format!(
                                "{} · {} · {}",
                                result.artists.join(", "),
                                result.album,
                                format_duration(result.duration_ms as f64 / 1000.0)
                            ))),
                    )
                    .child(button.on_click(move |_, window, cx| {
                        select_entity.update(cx, |this, cx| {
                            this.select_lyrics_song(id, window, cx);
                        });
                    }))
                    .into_any_element(),
            );
        }
        if rows.is_empty() && self.lyrics_searched {
            rows.push(
                div()
                    .text_sm()
                    .text_color(muted)
                    .child(s.lyrics_empty)
                    .into_any_element(),
            );
        }

        let song_block = if let Some(song) = &self.lyrics_song {
            let cover_entity = entity.clone();
            v_flex()
                .gap_2()
                .child(
                    div()
                        .text_lg()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(song.name.clone()),
                )
                .child(
                    h_flex()
                        .gap_4()
                        .flex_wrap()
                        .child(
                            div()
                                .text_xs()
                                .text_color(muted)
                                .child(song.artists.join(", ")),
                        )
                        .child(div().text_xs().text_color(muted).child(format!(
                            "{} · {}",
                            song.album,
                            format_duration(song.duration_ms as f64 / 1000.0)
                        ))),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(muted)
                        .child(format!("{}: {}", s.lyrics_cover, song.cover_url)),
                )
                .child(
                    Button::new("lyrics-cover")
                        .label(s.lyrics_download_cover)
                        .on_click(move |_, _, cx| {
                            cover_entity.update(cx, |this, cx| {
                                this.download_lyrics_cover(cx);
                            });
                        }),
                )
                .into_any_element()
        } else {
            div()
                .text_sm()
                .text_color(muted)
                .child(s.lyrics_no_song)
                .into_any_element()
        };

        let save_lrc_entity = entity.clone();
        let save_srt_entity = entity.clone();
        let to_pv_entity = entity.clone();
        let has_lyrics = !self.lyrics_editor.read(cx).value().trim().is_empty();
        let save_buttons = h_flex()
            .gap_2()
            .child(
                Button::new("lyrics-save-lrc")
                    .label(s.lyrics_save_lrc)
                    .primary()
                    .on_click(move |_, _, cx| {
                        save_lrc_entity.update(cx, |this, cx| this.save_lyrics(false, cx));
                    }),
            )
            .child(
                Button::new("lyrics-save-srt")
                    .label(s.lyrics_save_srt)
                    .on_click(move |_, _, cx| {
                        save_srt_entity.update(cx, |this, cx| this.save_lyrics(true, cx));
                    }),
            )
            .child(
                Button::new("lyrics-to-pv")
                    .label(s.lyrics_to_pv)
                    .disabled(!has_lyrics)
                    .on_click(move |_, window, cx| {
                        to_pv_entity.update(cx, |this, cx| this.send_lyrics_to_pv(window, cx));
                    }),
            );

        let translation = if self.lyrics_translation.trim().is_empty() {
            div().into_any_element()
        } else {
            v_flex()
                .gap_1()
                .child(
                    div()
                        .text_xs()
                        .text_color(muted)
                        .child(s.lyrics_translation),
                )
                .child(div().text_sm().child(self.lyrics_translation.clone()))
                .into_any_element()
        };
        let notice = self.lyrics_notice.as_ref().map(|notice| {
            div()
                .text_sm()
                .text_color(muted)
                .child(notice.clone())
                .into_any_element()
        });

        v_flex()
            .gap_4()
            .child(page_header(self.page, muted, s))
            .child(
                GroupBox::new()
                    .id("lyrics-search")
                    .outline()
                    .title(s.lyrics_search)
                    .child(
                        v_flex()
                            .gap_2()
                            .child(Input::new(&self.lyrics_query).w_full())
                            .child(
                                h_flex()
                                    .items_center()
                                    .gap_3()
                                    .child(search_button)
                                    .child(div().text_xs().text_color(muted).child(s.lyrics_hint)),
                            ),
                    ),
            )
            .child(
                GroupBox::new()
                    .id("lyrics-results")
                    .outline()
                    .title(s.lyrics_results)
                    .child(v_flex().gap_2().children(rows)),
            )
            .child(
                GroupBox::new()
                    .id("lyrics-song")
                    .outline()
                    .title(s.lyrics_song)
                    .child(song_block),
            )
            .child(
                GroupBox::new()
                    .id("lyrics-editor")
                    .outline()
                    .title(s.lyrics_editor)
                    .child(
                        v_flex()
                            .gap_2()
                            .child(Textarea::new(&self.lyrics_editor).h(px(320.)).w_full())
                            .child(save_buttons)
                            .child(translation)
                            .children(notice),
                    ),
            )
            .into_any_element()
    }

    fn render_audio(&self, cx: &mut Context<Self>) -> AnyElement {
        let dependency_panel = self.render_dependencies(&[DependencyId::Ffmpeg], cx, false);
        let theme = cx.theme();
        let muted = theme.muted_foreground;
        let border = theme.border;
        let primary = theme.primary;
        let background = theme.background;
        let entity = cx.entity();
        let s = self.text();

        let load_running = self
            .audio_load_job
            .is_some_and(|id| self.job_center.read(cx).is_running(id));
        let run_running = self
            .audio_run_job
            .is_some_and(|id| self.job_center.read(cx).is_running(id));
        let run_snapshot = self
            .audio_run_job
            .and_then(|id| self.job_center.read(cx).snapshot(id));

        let input_block = match (&self.audio_input, &self.audio_info) {
            (Some(path), Some(info)) => {
                let name = path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_else(|| path.display().to_string());
                v_flex()
                    .gap_2()
                    .child(div().text_sm().child(name))
                    .child(
                        div()
                            .text_xs()
                            .text_color(muted)
                            .child(path.display().to_string()),
                    )
                    .child(
                        h_flex()
                            .gap_4()
                            .flex_wrap()
                            .child(meta_text(
                                s.audio_duration,
                                format_duration(info.duration),
                                muted,
                            ))
                            .child(meta_text(
                                s.audio_sample_rate,
                                format!("{} Hz", info.sample_rate),
                                muted,
                            ))
                            .child(meta_text(
                                s.audio_channels,
                                info.channels.to_string(),
                                muted,
                            ))
                            .child(meta_text(s.audio_codec, info.codec.clone(), muted)),
                    )
                    .into_any_element()
            }
            (Some(path), None) => v_flex()
                .gap_1()
                .child(div().text_sm().child(path.display().to_string()))
                .child(div().text_xs().text_color(muted).child(s.audio_reading))
                .into_any_element(),
            (None, _) => div()
                .text_sm()
                .text_color(muted)
                .child(s.audio_no_file)
                .into_any_element(),
        };
        let add_entity = entity.clone();
        let add_button = Button::new("audio-add-file")
            .label(s.audio_add_file)
            .primary()
            .on_click(move |_, _, cx| {
                add_entity.update(cx, |this, cx| this.add_audio_file(cx));
            });

        let peaks = self.audio_peaks.clone();
        let selection = self.audio_selection;
        let bounds_slot = self.waveform_bounds.clone();
        let waveform = canvas(
            move |bounds, _, _| {
                *bounds_slot.borrow_mut() = Some(bounds);
            },
            move |bounds, _, window, _| {
                paint_waveform(
                    bounds, &peaks, selection, primary, background, border, window,
                );
            },
        )
        .size_full();
        let down_entity = entity.clone();
        let down_bounds = self.waveform_bounds.clone();
        let move_entity = entity.clone();
        let move_bounds = self.waveform_bounds.clone();
        let up_entity = entity.clone();
        let waveform_box = div()
            .id("audio-waveform")
            .h(px(168.))
            .w_full()
            .rounded(theme.radius)
            .overflow_hidden()
            .child(waveform)
            .on_mouse_down(MouseButton::Left, move |event, _, cx| {
                if let Some(fraction) = waveform_fraction(&down_bounds, event.position) {
                    down_entity.update(cx, |this, cx| {
                        this.audio_drag = Some(fraction);
                        this.audio_selection = Some((fraction, fraction));
                        cx.notify();
                    });
                }
            })
            .on_mouse_move(move |event, _, cx| {
                let Some(fraction) = waveform_fraction(&move_bounds, event.position) else {
                    return;
                };
                move_entity.update(cx, |this, cx| {
                    if let Some(anchor) = this.audio_drag {
                        this.audio_selection = Some((anchor, fraction));
                        cx.notify();
                    }
                });
            })
            .on_mouse_up(MouseButton::Left, move |_, _, cx| {
                up_entity.update(cx, |this, cx| {
                    this.audio_drag = None;
                    cx.notify();
                });
            });

        let operation_buttons = AudioOp::ALL
            .iter()
            .map(|operation| {
                let operation = *operation;
                let selected = self.audio_operation == operation;
                let entity = entity.clone();
                let mut button = Button::new(SharedString::from(format!(
                    "audio-op-{}",
                    operation.suffix()
                )))
                .label(operation.label(s))
                .compact();
                button = if selected {
                    button.primary()
                } else {
                    button.ghost()
                };
                button
                    .on_click(move |_, _, cx| {
                        entity.update(cx, |this, cx| {
                            this.audio_operation = operation;
                            cx.notify();
                        });
                    })
                    .into_any_element()
            })
            .collect::<Vec<_>>();

        let parameters: AnyElement = match self.audio_operation {
            AudioOp::Pitch => {
                let down_entity = entity.clone();
                let up_entity = entity.clone();
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(div().text_xs().text_color(muted).child(s.audio_semitones))
                    .child(
                        Button::new("audio-pitch-down")
                            .label("-")
                            .compact()
                            .on_click(move |_, _, cx| {
                                down_entity.update(cx, |this, cx| {
                                    this.audio_semitones = (this.audio_semitones - 1).max(-12);
                                    cx.notify();
                                });
                            }),
                    )
                    .child(
                        div()
                            .min_w(px(48.))
                            .text_center()
                            .text_sm()
                            .child(format!("{:+}", self.audio_semitones)),
                    )
                    .child(Button::new("audio-pitch-up").label("+").compact().on_click(
                        move |_, _, cx| {
                            up_entity.update(cx, |this, cx| {
                                this.audio_semitones = (this.audio_semitones + 1).min(12);
                                cx.notify();
                            });
                        },
                    ))
                    .into_any_element()
            }
            AudioOp::Speed => {
                let buttons = [0.5f32, 0.75, 1.0, 1.25, 1.5, 2.0]
                    .into_iter()
                    .map(|ratio| {
                        let selected = (self.audio_ratio - ratio).abs() < 0.001;
                        let entity = entity.clone();
                        let mut button = Button::new(SharedString::from(format!(
                            "audio-speed-{}",
                            (ratio * 100.0) as i32
                        )))
                        .label(format!("{ratio}x"))
                        .compact();
                        button = if selected {
                            button.primary()
                        } else {
                            button.ghost()
                        };
                        button
                            .on_click(move |_, _, cx| {
                                entity.update(cx, |this, cx| {
                                    this.audio_ratio = ratio;
                                    cx.notify();
                                });
                            })
                            .into_any_element()
                    })
                    .collect::<Vec<_>>();
                h_flex()
                    .gap_2()
                    .items_center()
                    .flex_wrap()
                    .child(div().text_xs().text_color(muted).child(s.audio_ratio))
                    .children(buttons)
                    .into_any_element()
            }
            AudioOp::Loudness => {
                let buttons = [-14, -16, -23]
                    .into_iter()
                    .map(|target| {
                        let selected = self.audio_lufs == target;
                        let entity = entity.clone();
                        let mut button =
                            Button::new(SharedString::from(format!("audio-lufs-{target}")))
                                .label(format!("{target} LUFS"))
                                .compact();
                        button = if selected {
                            button.primary()
                        } else {
                            button.ghost()
                        };
                        button
                            .on_click(move |_, _, cx| {
                                entity.update(cx, |this, cx| {
                                    this.audio_lufs = target;
                                    cx.notify();
                                });
                            })
                            .into_any_element()
                    })
                    .collect::<Vec<_>>();
                h_flex()
                    .gap_2()
                    .items_center()
                    .flex_wrap()
                    .child(div().text_xs().text_color(muted).child(s.audio_target))
                    .children(buttons)
                    .into_any_element()
            }
            AudioOp::Trim => {
                let text = match (self.audio_selection, self.audio_info.as_ref()) {
                    (Some((start, end)), Some(info)) => {
                        let (start, end) = (start.min(end), start.max(end));
                        format!(
                            "{}: {:.2}s – {:.2}s",
                            s.audio_selection,
                            start as f64 * info.duration,
                            end as f64 * info.duration
                        )
                    }
                    _ => s.audio_need_selection.to_string(),
                };
                div()
                    .text_xs()
                    .text_color(muted)
                    .child(text)
                    .into_any_element()
            }
            AudioOp::Convert | AudioOp::Extract => div().into_any_element(),
        };

        let format_buttons = AudioFormat::ALL
            .iter()
            .map(|format| {
                let format = *format;
                let selected = self.audio_format == format;
                let entity = entity.clone();
                let mut button =
                    Button::new(SharedString::from(format!("audio-format-{}", format.id())))
                        .label(format.label())
                        .compact();
                button = if selected {
                    button.primary()
                } else {
                    button.ghost()
                };
                button
                    .on_click(move |_, _, cx| {
                        entity.update(cx, |this, cx| {
                            this.audio_format = format;
                            cx.notify();
                        });
                    })
                    .into_any_element()
            })
            .collect::<Vec<_>>();

        let run_entity = entity.clone();
        let cancel_entity = entity.clone();
        let action_button = if run_running {
            Button::new("audio-cancel")
                .label(s.audio_cancel)
                .on_click(move |_, _, cx| {
                    cancel_entity.update(cx, |this, cx| this.cancel_audio(cx));
                })
                .into_any_element()
        } else {
            Button::new("audio-run")
                .label(s.audio_run)
                .primary()
                .on_click(move |_, _, cx| {
                    run_entity.update(cx, |this, cx| this.start_audio(cx));
                })
                .into_any_element()
        };

        let progress_block = if load_running {
            div()
                .text_xs()
                .text_color(muted)
                .child(s.audio_reading)
                .into_any_element()
        } else if let Some(snapshot) = &run_snapshot {
            if snapshot.status.is_running() {
                v_flex()
                    .gap_1()
                    .child(div().text_xs().text_color(muted).child(s.audio_running))
                    .child(
                        div()
                            .text_xs()
                            .text_color(muted)
                            .child(snapshot.message.clone()),
                    )
                    .child(
                        div().h(px(4.)).w_full().rounded(px(2.)).bg(border).child(
                            div()
                                .h_full()
                                .w(relative(snapshot.progress.unwrap_or(0.0)))
                                .rounded(px(2.))
                                .bg(primary),
                        ),
                    )
                    .into_any_element()
            } else {
                div().into_any_element()
            }
        } else {
            div().into_any_element()
        };
        let notice = self.audio_notice.as_ref().map(|notice| {
            div()
                .text_sm()
                .text_color(muted)
                .child(notice.clone())
                .into_any_element()
        });

        v_flex()
            .gap_4()
            .child(page_header(self.page, muted, s))
            .child(dependency_panel)
            .child(
                GroupBox::new()
                    .id("audio-file")
                    .outline()
                    .title(s.audio_input)
                    .child(
                        v_flex()
                            .gap_3()
                            .child(input_block)
                            .child(h_flex().items_center().gap_2().child(add_button)),
                    ),
            )
            .child(
                GroupBox::new()
                    .id("audio-waveform")
                    .outline()
                    .title(s.audio_waveform)
                    .child(
                        v_flex().gap_2().child(waveform_box).child(
                            div()
                                .text_xs()
                                .text_color(muted)
                                .child(s.audio_selection_hint),
                        ),
                    ),
            )
            .child(
                GroupBox::new()
                    .id("audio-operation")
                    .outline()
                    .title(s.audio_operation)
                    .child(
                        v_flex()
                            .gap_2()
                            .child(h_flex().gap_2().flex_wrap().children(operation_buttons))
                            .child(parameters),
                    ),
            )
            .child(
                GroupBox::new()
                    .id("audio-format")
                    .outline()
                    .title(s.audio_format)
                    .child(
                        v_flex()
                            .gap_2()
                            .child(h_flex().gap_2().flex_wrap().children(format_buttons))
                            .child(div().text_xs().text_color(muted).child(s.audio_output_hint)),
                    ),
            )
            .child(
                GroupBox::new()
                    .id("audio-actions")
                    .outline()
                    .title(s.page_audio)
                    .child(
                        v_flex()
                            .gap_2()
                            .child(action_button)
                            .child(progress_block)
                            .children(notice),
                    ),
            )
            .into_any_element()
    }

    fn render_convert(&self, cx: &mut Context<Self>) -> AnyElement {
        let dependency_panel = self.render_dependencies(&[DependencyId::LibreSvip], cx, false);
        let theme = cx.theme();
        let muted = theme.muted_foreground;
        let border = theme.border;
        let entity = cx.entity();
        let s = self.text();

        let preview_running = self
            .convert_preview_job
            .is_some_and(|id| self.job_center.read(cx).is_running(id));
        let convert_running = self
            .convert_job
            .is_some_and(|id| self.job_center.read(cx).is_running(id));
        let convert_snapshot = self
            .convert_job
            .and_then(|id| self.job_center.read(cx).snapshot(id));

        let mut file_rows = Vec::new();
        for (index, path) in self.convert_inputs.iter().enumerate() {
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| path.display().to_string());
            let detail = path.display().to_string();
            let remove_entity = entity.clone();
            file_rows.push(
                h_flex()
                    .justify_between()
                    .items_center()
                    .gap_4()
                    .py_1()
                    .border_b_1()
                    .border_color(border)
                    .child(
                        v_flex()
                            .gap_1()
                            .min_w_0()
                            .child(div().text_sm().child(name))
                            .child(div().text_xs().text_color(muted).child(detail)),
                    )
                    .child(
                        Button::new(SharedString::from(format!("convert-remove-{index}")))
                            .label(s.convert_remove)
                            .compact()
                            .on_click(move |_, _, cx| {
                                remove_entity.update(cx, |this, cx| {
                                    this.remove_convert_file(index, cx);
                                });
                            }),
                    )
                    .into_any_element(),
            );
        }
        if file_rows.is_empty() {
            file_rows.push(
                div()
                    .text_sm()
                    .text_color(muted)
                    .child(s.convert_no_files)
                    .into_any_element(),
            );
        }

        let add_entity = entity.clone();
        let clear_entity = entity.clone();
        let file_actions = h_flex()
            .gap_2()
            .items_center()
            .child(
                Button::new("convert-add-files")
                    .label(s.convert_add_files)
                    .primary()
                    .on_click(move |_, _, cx| {
                        add_entity.update(cx, |this, cx| this.add_convert_files(cx));
                    }),
            )
            .child(
                Button::new("convert-clear-files")
                    .label(s.convert_clear_files)
                    .ghost()
                    .on_click(move |_, _, cx| {
                        clear_entity.update(cx, |this, cx| this.clear_convert_files(cx));
                    }),
            );

        let format_buttons = formats::ALL
            .iter()
            .map(|format| {
                let selected = self.convert_format.id == format.id;
                let format: &'static Format = format;
                let entity = entity.clone();
                let mut button =
                    Button::new(SharedString::from(format!("convert-format-{}", format.id)))
                        .label(format!("{} (*.{})", format.name, format.id))
                        .compact();
                button = if selected {
                    button.primary()
                } else {
                    button.ghost()
                };
                button
                    .on_click(move |_, _, cx| {
                        entity.update(cx, |this, cx| {
                            this.convert_format = format;
                            cx.notify();
                        });
                    })
                    .into_any_element()
            })
            .collect::<Vec<_>>();

        let output_value = self.output_input.read(cx).value().trim().to_string();
        let output_detail = if output_value.is_empty() {
            s.convert_same_dir.to_string()
        } else {
            output_value
        };
        let choose_entity = entity.clone();
        let choose_button = Button::new("convert-output-dir")
            .label(s.convert_choose_folder)
            .on_click(move |_, window, cx| {
                choose_entity.update(cx, |this, cx| {
                    this.choose_convert_output_dir(window, cx);
                });
            });

        let preview_entity = entity.clone();
        let inspect_button = Button::new("convert-inspect")
            .label(if preview_running {
                s.convert_inspecting
            } else {
                s.convert_inspect
            })
            .ghost()
            .on_click(move |_, _, cx| {
                if !preview_running {
                    preview_entity.update(cx, |this, cx| this.inspect_convert(cx));
                }
            });
        let preview_block = match &self.convert_preview {
            Some((path, info)) => {
                let name = path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_else(|| path.display().to_string());
                let bpm = info
                    .bpm
                    .map(|bpm| format!(" · {:.0} {}", bpm, s.convert_bpm))
                    .unwrap_or_default();
                let tracks = if info.track_names.is_empty() {
                    String::new()
                } else {
                    format!(" · {}", info.track_names.join(", "))
                };
                v_flex()
                    .gap_1()
                    .child(div().text_sm().child(name))
                    .child(div().text_xs().text_color(muted).child(format!(
                        "{} {} · {} {}{}{}",
                        info.tracks, s.convert_tracks, info.notes, s.convert_notes, bpm, tracks
                    )))
                    .into_any_element()
            }
            None => div().into_any_element(),
        };

        let progress_block = match &convert_snapshot {
            Some(snapshot) if snapshot.status.is_running() => {
                let percent = snapshot
                    .progress
                    .map(|fraction| format!("{:.0}%", fraction * 100.0))
                    .unwrap_or_default();
                v_flex()
                    .gap_1()
                    .child(div().text_xs().text_color(muted).child(s.convert_running))
                    .child(
                        div()
                            .text_xs()
                            .text_color(muted)
                            .child(format!("{} {percent}", snapshot.message)),
                    )
                    .child(
                        div().h(px(4.)).w_full().rounded(px(2.)).bg(border).child(
                            div()
                                .h_full()
                                .w(relative(snapshot.progress.unwrap_or(0.0)))
                                .rounded(px(2.))
                                .bg(theme.primary),
                        ),
                    )
                    .into_any_element()
            }
            _ => div().into_any_element(),
        };

        let start_entity = entity.clone();
        let cancel_entity = entity.clone();
        let action_button = if convert_running {
            Button::new("convert-cancel")
                .label(s.convert_cancel)
                .on_click(move |_, _, cx| {
                    cancel_entity.update(cx, |this, cx| this.cancel_convert(cx));
                })
                .into_any_element()
        } else {
            Button::new("convert-start")
                .label(s.convert_start)
                .primary()
                .on_click(move |_, _, cx| {
                    start_entity.update(cx, |this, cx| this.start_convert(cx));
                })
                .into_any_element()
        };

        let notice_color = theme.primary;
        let notice = self.convert_notice.as_ref().map(|notice| {
            div()
                .text_sm()
                .text_color(notice_color)
                .child(notice.clone())
                .into_any_element()
        });

        v_flex()
            .gap_4()
            .child(page_header(self.page, muted, s))
            .child(dependency_panel)
            .child(
                GroupBox::new()
                    .id("convert-files")
                    .outline()
                    .title(s.convert_files)
                    .child(v_flex().gap_2().children(file_rows).child(file_actions)),
            )
            .child(
                GroupBox::new()
                    .id("convert-formats")
                    .outline()
                    .title(s.convert_output_format)
                    .child(
                        v_flex()
                            .gap_2()
                            .child(h_flex().gap_2().flex_wrap().children(format_buttons))
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(muted)
                                    .child(s.convert_defaults_hint),
                            ),
                    ),
            )
            .child(
                GroupBox::new()
                    .id("convert-output")
                    .outline()
                    .title(s.convert_output_dir)
                    .child(
                        v_flex()
                            .gap_2()
                            .child(
                                h_flex()
                                    .justify_between()
                                    .items_center()
                                    .gap_4()
                                    .child(div().text_sm().text_color(muted).child(output_detail))
                                    .child(choose_button),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(muted)
                                    .child(s.convert_output_hint),
                            )
                            .child(
                                h_flex().items_center().gap_2().child(inspect_button).child(
                                    div()
                                        .text_xs()
                                        .text_color(muted)
                                        .child(s.convert_preview_hint),
                                ),
                            )
                            .child(div().text_xs().text_color(muted).child(s.convert_preview))
                            .child(preview_block),
                    ),
            )
            .child(
                GroupBox::new()
                    .id("convert-actions")
                    .outline()
                    .title(s.page_convert)
                    .child(
                        v_flex()
                            .gap_2()
                            .child(action_button)
                            .child(progress_block)
                            .children(notice),
                    ),
            )
            .into_any_element()
    }

    fn render_settings(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let announcements = self.render_announcements(cx, usize::MAX);
        let updates = self.render_updates(cx);
        let dependencies_panel = self.render_dependencies(&ALL_DEPENDENCIES, cx, true);
        let (muted, border) = {
            let theme = cx.theme();
            (theme.muted_foreground, theme.border)
        };
        let s = self.text();
        let theme_buttons = ThemePreference::ALL
            .into_iter()
            .map(|preference| self.render_theme_button(preference, false, cx))
            .collect::<Vec<_>>();
        let language_buttons = Language::ALL
            .iter()
            .map(|language| {
                let language = *language;
                let selected = self.config.language == language;
                let entity = cx.entity();
                let mut button =
                    Button::new(SharedString::from(format!("lang-{}", language.code())))
                        .label(language.label());
                button = if selected {
                    button.primary()
                } else {
                    button.ghost()
                };
                button
                    .on_click(move |_, _, cx| {
                        entity.update(cx, |this, cx| this.set_language(language, cx));
                    })
                    .into_any_element()
            })
            .collect::<Vec<_>>();
        let sponsor_theme = cx.theme();
        let entity = cx.entity();
        let output_open = entity.clone();
        let download_open = entity.clone();
        let ext_open = entity.clone();
        let tools_open = entity.clone();
        let data_open = entity.clone();
        let logs_open = entity.clone();
        let has_output = !self.output_input.read(cx).value().trim().is_empty();
        let directories_group = GroupBox::new()
            .id("settings-directories")
            .outline()
            .title(s.directories)
            .child(
                v_flex()
                    .gap_2()
                    .child(
                        h_flex()
                            .flex_wrap()
                            .gap_2()
                            .child(
                                Button::new("open-output-dir")
                                    .label(s.output_dir)
                                    .compact()
                                    .disabled(!has_output)
                                    .on_click(move |_, _, cx| {
                                        output_open.update(cx, |this, cx| this.open_output_dir(cx));
                                    }),
                            )
                            .child(
                                Button::new("open-download-dir")
                                    .label(s.download_dir)
                                    .compact()
                                    .on_click(move |_, _, cx| {
                                        download_open
                                            .update(cx, |this, cx| this.open_download_dir(cx));
                                    }),
                            )
                            .child(
                                Button::new("open-ext-dir")
                                    .label(s.ext_dir)
                                    .compact()
                                    .on_click(move |_, _, cx| {
                                        ext_open.update(cx, |this, cx| this.open_ext_dir(cx));
                                    }),
                            )
                            .child(
                                Button::new("open-tools-dir")
                                    .label(s.tools_dir)
                                    .compact()
                                    .on_click(move |_, _, cx| {
                                        tools_open.update(cx, |this, cx| this.open_tools_dir(cx));
                                    }),
                            )
                            .child(
                                Button::new("open-data-dir")
                                    .label(s.data_dir)
                                    .compact()
                                    .on_click(move |_, _, cx| {
                                        data_open.update(cx, |this, cx| this.open_data_dir(cx));
                                    }),
                            )
                            .child(
                                Button::new("open-logs-dir")
                                    .label(s.logs_dir)
                                    .compact()
                                    .on_click(move |_, _, cx| {
                                        logs_open.update(cx, |this, cx| this.open_logs_dir(cx));
                                    }),
                            ),
                    )
                    .child(div().text_xs().text_color(muted).child(s.directories_hint)),
            );

        v_flex()
            .gap_4()
            .child(page_header(self.page, muted, self.text()))
            .child(
                GroupBox::new()
                    .id("settings-appearance")
                    .outline()
                    .title(s.appearance)
                    .child(
                        v_flex()
                            .gap_3()
                            .child(div().text_sm().child(s.theme))
                            .child(h_flex().gap_2().children(theme_buttons))
                            .child(div().text_xs().text_color(muted).child(s.theme_hint)),
                    ),
            )
            .child(
                GroupBox::new()
                    .id("settings-paths")
                    .outline()
                    .title(s.paths)
                    .child(
                        v_flex()
                            .gap_3()
                            .child(path_field(
                                s.output_dir,
                                &self.output_input,
                                s.output_hint,
                                muted,
                                s,
                            ))
                            .child(path_field(
                                s.download_dir,
                                &self.download_input,
                                s.download_hint,
                                muted,
                                s,
                            ))
                            .child(path_field(s.ext_dir, &self.ext_input, s.ext_hint, muted, s))
                            .child(info_row(s.tools_dir, tools_dir_display(), muted, border))
                            .child(
                                h_flex()
                                    .items_center()
                                    .gap_3()
                                    .child(
                                        Button::new("save-paths")
                                            .label(s.save_paths)
                                            .primary()
                                            .on_click({
                                                let entity = cx.entity();
                                                move |_, _, cx| {
                                                    entity
                                                        .update(cx, |this, cx| this.save_paths(cx));
                                                }
                                            }),
                                    )
                                    .child(div().text_xs().text_color(muted).child(s.save_hint)),
                            ),
                    ),
            )
            .child(directories_group)
            .child(announcements)
            .child(updates)
            .child(dependencies_panel)
            .child(
                GroupBox::new()
                    .id("settings-config")
                    .outline()
                    .title(s.config)
                    .child(
                        v_flex()
                            .gap_1()
                            .child(info_row(s.file, config_path_display(), muted, border))
                            .child(info_row(
                                s.current_theme,
                                theme_label(self.config.theme, s).to_string(),
                                muted,
                                border,
                            ))
                            .child(
                                h_flex()
                                    .justify_between()
                                    .items_center()
                                    .child(div().text_xs().text_color(muted).child(s.language))
                                    .child(h_flex().gap_2().children(language_buttons)),
                            ),
                    ),
            )
            .child(
                GroupBox::new()
                    .id("settings-sponsor")
                    .outline()
                    .title(s.sponsor)
                    .child(
                        v_flex()
                            .gap_3()
                            .child(
                                div()
                                    .max_w(px(560.))
                                    .text_sm()
                                    .text_color(muted)
                                    .child(s.sponsor_text),
                            )
                            .child(h_flex().gap_4().children([
                                sponsor_card(
                                    "img/sponsor.jpg",
                                    s.wechat,
                                    180.,
                                    180.,
                                    sponsor_theme,
                                ),
                                sponsor_card(
                                    "img/sponsor-alipay.jpg",
                                    s.alipay,
                                    120.,
                                    180.,
                                    sponsor_theme,
                                ),
                            ]))
                            .child(div().text_xs().text_color(muted).child(s.sponsor_hint)),
                    ),
            )
            .child(
                GroupBox::new()
                    .id("settings-about")
                    .outline()
                    .title(s.about)
                    .child(
                        v_flex()
                            .gap_1()
                            .child(info_row(
                                s.version,
                                env!("CARGO_PKG_VERSION").to_string(),
                                muted,
                                border,
                            ))
                            .child(info_row(
                                s.runtime,
                                format!("{} / {}", std::env::consts::OS, std::env::consts::ARCH),
                                muted,
                                border,
                            ))
                            .child(info_row(
                                s.license,
                                "GPL-3.0-only".to_string(),
                                muted,
                                border,
                            ))
                            .child(info_row(s.author, "QingMu39".to_string(), muted, border))
                            .child(
                                div()
                                    .pt_2()
                                    .text_xs()
                                    .text_color(muted)
                                    .child(s.third_party),
                            )
                            .child(bullet_line("LibreSVIP 2.9.2 · Apache-2.0"))
                            .child(bullet_line("FFmpeg · LGPL / GPL（随平台不同）"))
                            .child(bullet_line("yt-dlp · Unlicense"))
                            .child(bullet_line("JIZURA v0.10.1 · MIT"))
                            .child(bullet_line("ONNX Runtime / ort · MIT"))
                            .child(bullet_line("gpui-kit 0.8 / GPUI · Apache-2.0"))
                            .child(div().text_xs().text_color(muted).child(s.third_party_full)),
                    ),
            )
    }

    fn render_resources(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let muted = theme.muted_foreground;
        let border = theme.border;
        let warning = theme.warning;
        let danger = theme.danger;
        let radius = theme.radius;
        let entity = cx.entity();
        let s = self.text();

        let query = self.resource_search.read(cx).value().to_lowercase();
        let query = query.trim();
        let active_group = self.resource_group.as_deref();

        let mut groups: Vec<(&Group, Vec<&Item>)> = Vec::new();
        for group in &self.resources.groups {
            if active_group.is_some_and(|id| group.id != id) {
                continue;
            }
            let items = group
                .items
                .iter()
                .filter(|item| resource_matches(item, query))
                .collect::<Vec<_>>();
            if !items.is_empty() {
                groups.push((group, items));
            }
        }
        let total: usize = groups.iter().map(|(_, items)| items.len()).sum();

        let mut group_buttons = vec![resource_group_button(
            s.all,
            None,
            self.resource_group.is_none(),
            entity.clone(),
        )];
        for group in &self.resources.groups {
            group_buttons.push(resource_group_button(
                &group.name,
                Some(group.id.clone()),
                active_group == Some(group.id.as_str()),
                entity.clone(),
            ));
        }

        let mut sections = Vec::new();
        for (group, items) in &groups {
            let cards = items
                .iter()
                .map(|item| resource_card(item, &group.id, theme, entity.clone(), s))
                .collect::<Vec<_>>();
            sections.push(
                v_flex()
                    .gap_2()
                    .child(
                        h_flex()
                            .items_center()
                            .gap_2()
                            .child(
                                div()
                                    .text_lg()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(group.name.clone()),
                            )
                            .child(div().text_xs().text_color(muted).child(format!(
                                "{} {}",
                                items.len(),
                                s.item_count
                            ))),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(muted)
                            .child(group.description.clone()),
                    )
                    .child(h_flex().flex_wrap().gap_3().children(cards))
                    .into_any_element(),
            );
        }

        let count = if query.is_empty() && active_group.is_none() {
            format!(
                "{} {} / {} {}",
                self.resources.item_count(),
                s.item_count,
                self.resources.groups.len(),
                s.group_count
            )
        } else {
            format!(
                "{} {} {} / {} {}",
                s.filtered,
                total,
                s.item_count,
                groups.len(),
                s.group_count
            )
        };

        let mut page = v_flex()
            .gap_4()
            .child(page_header(self.page, muted, self.text()))
            .child(
                h_flex()
                    .items_center()
                    .gap_3()
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(Input::new(&self.resource_search).w_full()),
                    )
                    .child(div().text_xs().text_color(muted).child(count)),
            );

        if let Some(error) = &self.resource_error {
            page = page.child(callout(error, danger, radius));
        } else if !self.resources.notice.is_empty() {
            page = page.child(callout(&self.resources.notice, warning, radius));
        }

        if !self.resources.updated_at.is_empty() {
            page = page.child(
                div()
                    .text_xs()
                    .text_color(muted)
                    .child(format!("{} {}", s.updated_at, self.resources.updated_at)),
            );
        }

        page = page
            .child(h_flex().flex_wrap().gap_2().children(group_buttons))
            .child(v_flex().gap_5().children(sections));

        if total == 0 {
            page = page.child(
                div()
                    .p_6()
                    .border_1()
                    .border_color(border)
                    .rounded(radius)
                    .text_sm()
                    .text_color(muted)
                    .child(s.no_match),
            );
        }

        page
    }
}

impl Render for VSynthApp {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let background = theme.background;
        let foreground = theme.foreground;

        div()
            .flex()
            .flex_col()
            .size_full()
            .bg(background)
            .text_color(foreground)
            .child(self.render_title_bar(cx))
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .child(self.render_sidebar(cx))
                    .child(self.render_main(cx)),
            )
    }
}

pub fn apply_theme(preference: ThemePreference, window: &mut Window, cx: &mut App) {
    let mode = match preference {
        ThemePreference::System => window.appearance().into(),
        ThemePreference::Light => ThemeMode::Light,
        ThemePreference::Dark => ThemeMode::Dark,
    };
    Theme::change(mode, Some(window), cx);
}

fn page_header(page: Page, muted: Hsla, s: &Strings) -> impl IntoElement {
    v_flex()
        .gap_1()
        .child(
            div()
                .text_2xl()
                .font_weight(FontWeight::BOLD)
                .child(page.title(s)),
        )
        .child(div().text_sm().text_color(muted).child(page.subtitle(s)))
}

fn unique_output(input: &Path, format: &Format, output_dir: Option<&Path>) -> PathBuf {
    let directory = output_dir
        .map(Path::to_path_buf)
        .or_else(|| input.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    let stem = input
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| "output".to_string());
    let mut candidate = directory.join(format!("{stem}.{}", format.id));
    let mut index = 1;
    while candidate.exists() {
        candidate = directory.join(format!("{stem}-{index}.{}", format.id));
        index += 1;
    }
    candidate
}

fn audio_output_path(input: &Path, operation: AudioOp, format: AudioFormat) -> PathBuf {
    let directory = input.parent().unwrap_or_else(|| Path::new("."));
    let stem = input
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| "audio".to_string());
    let base = format!("{stem}_{}", operation.suffix());
    let mut candidate = directory.join(format!("{base}.{}", format.id()));
    let mut index = 1;
    while candidate.exists() {
        candidate = directory.join(format!("{base}-{index}.{}", format.id()));
        index += 1;
    }
    candidate
}

fn video_file_name(info: &ParsedVideo, page: &VideoPage, quality: u32) -> String {
    let title = sanitize_filename(&info.title);
    let page_suffix = if info.pages.len() > 1 {
        format!("-P{}", page.page)
    } else {
        String::new()
    };
    format!("{title}{page_suffix}-{quality}.mp4")
}

fn sanitize_filename(title: &str) -> String {
    let mut name = title
        .chars()
        .map(|character| {
            if character.is_control() || "<>:\"/\\|?*".contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    name = name.trim().trim_matches('.').trim().to_string();
    if name.chars().count() > 80 {
        name = name.chars().take(80).collect();
    }
    if name.is_empty() {
        "video".to_string()
    } else {
        name
    }
}

fn unique_video_output(directory: &Path, name: &str) -> PathBuf {
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| "video".to_string());
    let extension = path
        .extension()
        .map(|extension| extension.to_string_lossy().to_string())
        .unwrap_or_else(|| "mp4".to_string());
    let mut candidate = directory.join(name);
    let mut index = 1;
    while candidate.exists() {
        candidate = directory.join(format!("{stem}-{index}.{extension}"));
        index += 1;
    }
    candidate
}

fn default_download_dir() -> PathBuf {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join("Downloads")
}

fn format_duration(seconds: f64) -> String {
    if !seconds.is_finite() || seconds <= 0.0 {
        return "0:00".to_string();
    }
    let minutes = (seconds / 60.0).floor() as u64;
    let rest = seconds - minutes as f64 * 60.0;
    format!("{minutes}:{rest:04.1}")
}

fn dependency_purpose(id: DependencyId, s: &Strings) -> &'static str {
    match id {
        DependencyId::LibreSvip => s.dep_libresvip,
        DependencyId::Ffmpeg => s.dep_ffmpeg,
        DependencyId::YtDlp => s.dep_ytdlp,
        DependencyId::Python => s.dep_python,
        DependencyId::UvrModel => s.dep_uvr,
        DependencyId::GameModel => s.dep_game,
    }
}

fn announce_badge(label: &'static str, color: Hsla, radius: Pixels) -> impl IntoElement {
    div()
        .px_2()
        .py_1()
        .rounded(radius)
        .bg(color.opacity(0.14))
        .text_color(color)
        .text_xs()
        .child(label)
}

fn meta_text(label: &'static str, value: String, muted: Hsla) -> impl IntoElement {
    h_flex()
        .gap_1()
        .child(div().text_xs().text_color(muted).child(label))
        .child(div().text_xs().child(value))
}

fn waveform_fraction(
    bounds: &Rc<RefCell<Option<Bounds<Pixels>>>>,
    position: Point<Pixels>,
) -> Option<f32> {
    let bounds = (*bounds.borrow())?;
    let width = bounds.size.width.as_f32();
    if width <= 0.0 {
        return None;
    }
    Some(((position.x - bounds.origin.x).as_f32() / width).clamp(0.0, 1.0))
}

fn paint_waveform(
    bounds: Bounds<Pixels>,
    peaks: &[f32],
    selection: Option<(f32, f32)>,
    primary: Hsla,
    background: Hsla,
    border: Hsla,
    window: &mut Window,
) {
    window.paint_quad(quad(
        bounds,
        px(4.),
        background,
        px(1.),
        border,
        Default::default(),
    ));
    if peaks.is_empty() {
        return;
    }
    let width = bounds.size.width.as_f32();
    let height = bounds.size.height.as_f32();
    let bar_width = (width / peaks.len() as f32).max(1.0);
    for (index, peak) in peaks.iter().enumerate() {
        let peak = peak.clamp(0.0, 1.0);
        if peak <= 0.001 {
            continue;
        }
        let bar_height = (height * 0.88 * peak).max(1.0);
        let x = bounds.origin.x.as_f32() + index as f32 / peaks.len() as f32 * width;
        let y = bounds.origin.y.as_f32() + (height - bar_height) / 2.0;
        let bar = Bounds {
            origin: point(px(x), px(y)),
            size: size(px(bar_width), px(bar_height)),
        };
        window.paint_quad(quad(
            bar,
            px(0.),
            primary,
            px(0.),
            transparent_black(),
            Default::default(),
        ));
    }
    if let Some((start, end)) = selection {
        let (start, end) = (
            start.min(end).clamp(0.0, 1.0),
            start.max(end).clamp(0.0, 1.0),
        );
        if end > start {
            let overlay = Bounds {
                origin: point(
                    px(bounds.origin.x.as_f32() + start * width),
                    bounds.origin.y,
                ),
                size: size(px((end - start) * width), bounds.size.height),
            };
            window.paint_quad(quad(
                overlay,
                px(0.),
                primary.opacity(0.18),
                px(0.),
                transparent_black(),
                Default::default(),
            ));
            for edge in [start, end] {
                let line = Bounds {
                    origin: point(px(bounds.origin.x.as_f32() + edge * width), bounds.origin.y),
                    size: size(px(2.), bounds.size.height),
                };
                window.paint_quad(quad(
                    line,
                    px(0.),
                    primary,
                    px(0.),
                    transparent_black(),
                    Default::default(),
                ));
            }
        }
    }
}

fn theme_label(preference: ThemePreference, s: &Strings) -> &'static str {
    match preference {
        ThemePreference::System => s.theme_system,
        ThemePreference::Light => s.theme_light,
        ThemePreference::Dark => s.theme_dark,
    }
}

fn note_name(pitch: f32) -> String {
    const NAMES: [&str; 12] = [
        "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
    ];
    let midi = pitch.round() as i32;
    let name = NAMES[midi.rem_euclid(12) as usize];
    format!("{name}{}", midi / 12 - 1)
}

fn info_row(label: &'static str, value: String, muted: Hsla, border: Hsla) -> impl IntoElement {
    h_flex()
        .justify_between()
        .items_center()
        .gap_4()
        .py_1()
        .border_b_1()
        .border_color(border)
        .child(div().text_sm().text_color(muted).child(label))
        .child(div().text_sm().child(value))
}

fn bullet_line(text: &'static str) -> impl IntoElement {
    div().text_sm().child(format!("• {text}"))
}

fn config_path_display() -> String {
    let path = crate::config::config_path();
    path.strip_prefix(crate::config::data_dir())
        .map(|relative| format!("data/{}", relative.display()))
        .unwrap_or_else(|_| path.display().to_string())
}

fn tools_dir_display() -> String {
    let path = crate::config::tools_dir();
    path.strip_prefix(crate::config::app_root())
        .map(|relative| relative.display().to_string())
        .unwrap_or_else(|_| path.display().to_string())
}

fn path_field(
    label: &'static str,
    input: &Entity<InputState>,
    hint: &'static str,
    muted: Hsla,
    s: &Strings,
) -> impl IntoElement {
    let browse_input = input.clone();
    let clear_input = input.clone();
    let browse_id = SharedString::from(format!("browse-{label}"));
    let clear_id = SharedString::from(format!("clear-{label}"));

    v_flex()
        .gap_1()
        .child(div().text_xs().text_color(muted).child(label))
        .child(
            h_flex()
                .items_center()
                .gap_2()
                .child(div().flex_1().min_w_0().child(Input::new(input).w_full()))
                .child(
                    Button::new(browse_id)
                        .label(s.browse)
                        .on_click(move |_, window, cx| {
                            let current = browse_input.read(cx).value().to_string();
                            if let Some(path) = pick_folder(&current) {
                                browse_input.update(cx, |state, cx| {
                                    state.set_value(path.to_string_lossy().to_string(), window, cx);
                                });
                            }
                        }),
                )
                .child(
                    Button::new(clear_id)
                        .label(s.clear)
                        .on_click(move |_, window, cx| {
                            clear_input.update(cx, |state, cx| {
                                state.set_value("", window, cx);
                            });
                        }),
                ),
        )
        .child(div().text_xs().text_color(muted).child(hint))
}

fn pick_folder(start: &str) -> Option<std::path::PathBuf> {
    let mut dialog = rfd::FileDialog::new();
    if !start.trim().is_empty() {
        dialog = dialog.set_directory(start);
    }
    dialog.pick_folder()
}

fn resource_group_button(
    label: &str,
    group: Option<String>,
    selected: bool,
    entity: Entity<VSynthApp>,
) -> AnyElement {
    let id = SharedString::from(format!("res-group-{}", group.as_deref().unwrap_or("all")));
    let mut button = Button::new(id).label(label.to_string()).compact();
    button = if selected {
        button.primary()
    } else {
        button.ghost()
    };
    button
        .on_click(move |_, _, cx| {
            let group = group.clone();
            entity.update(cx, |this, cx| {
                this.resource_group = group;
                cx.notify();
            });
        })
        .into_any_element()
}

fn resource_card(
    item: &Item,
    group_id: &str,
    theme: &Theme,
    entity: Entity<VSynthApp>,
    s: &Strings,
) -> AnyElement {
    let name = if item.name.trim().is_empty() {
        s.unnamed.to_string()
    } else {
        item.name.clone()
    };
    let url = item.url.clone();
    let id = SharedString::from(format!(
        "res-open-{group_id}-{}",
        if item.id.is_empty() {
            item.name.as_str()
        } else {
            item.id.as_str()
        }
    ));
    let open = Button::new(id)
        .label(s.open)
        .primary()
        .compact()
        .on_click(move |_, _, cx| {
            entity.update(cx, |this, cx| this.open_resource(&url, cx));
        });

    let mut head = h_flex().items_center().gap_2().child(
        div()
            .flex_1()
            .min_w_0()
            .text_sm()
            .font_weight(FontWeight::SEMIBOLD)
            .child(name),
    );
    if item.official {
        head = head.child(pill(s.official, theme.success, theme.radius));
    }
    if let Some((label, color)) = resource_verdict(item, theme) {
        head = head.child(pill(label, color, theme.radius));
    }

    let tags = item
        .tags
        .iter()
        .take(3)
        .map(|tag| {
            div()
                .px_2()
                .py_1()
                .rounded(theme.radius)
                .border_1()
                .border_color(theme.border)
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(tag.clone())
        })
        .collect::<Vec<_>>();

    let mut card = v_flex()
        .w(px(340.))
        .flex_none()
        .gap_2()
        .p_4()
        .rounded(theme.radius)
        .border_1()
        .border_color(theme.border)
        .bg(theme.secondary)
        .child(head)
        .child(
            div()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(host_of(item)),
        )
        .child(h_flex().flex_wrap().gap_1().children(tags));

    if !item.region.is_empty() || !item.cost.is_empty() {
        card = card.child(
            div()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(format!("{} · {}", item.region, item.cost)),
        );
    }
    if !item.desc.is_empty() {
        card = card.child(
            div()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(truncate(&item.desc, 150)),
        );
    }
    if !item.tip.is_empty() {
        card = card.child(
            div()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(truncate(&item.tip, 90)),
        );
    }
    if let Some(checked_at) = item
        .verified
        .as_ref()
        .map(|verified| verified.checked_at.as_str())
        .filter(|checked_at| !checked_at.is_empty())
    {
        card = card.child(
            div()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(format!("{}: {checked_at}", s.checked)),
        );
    }

    card.child(h_flex().child(open)).into_any_element()
}

fn resource_matches(item: &Item, query: &str) -> bool {
    if query.is_empty() {
        return true;
    }
    let haystack = format!(
        "{} {} {} {} {} {}",
        item.name,
        item.desc,
        item.home,
        item.cost,
        item.region,
        item.tags.join(" ")
    )
    .to_lowercase();
    haystack.contains(query)
}

fn resource_verdict(item: &Item, theme: &Theme) -> Option<(&'static str, Hsla)> {
    let verified = item.verified.as_ref()?;
    let label = match verified.verdict.as_str() {
        "ok" => "可达",
        "dead" => "失效",
        "warn" => "存疑",
        _ => match verified.status {
            Some(200 | 301 | 302 | 307 | 308) => "可达",
            Some(404 | 410) => "失效",
            Some(_) => "存疑",
            None => return None,
        },
    };
    let color = match label {
        "可达" => theme.success,
        "失效" => theme.danger,
        _ => theme.warning,
    };
    Some((label, color))
}

fn host_of(item: &Item) -> String {
    let home = item
        .home
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/');
    if !home.is_empty() {
        return home.to_string();
    }
    item.url
        .split("://")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .unwrap_or("")
        .to_string()
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut out = text.chars().take(limit).collect::<String>();
    out.push('…');
    out
}

fn pill(text: &'static str, color: Hsla, radius: Pixels) -> impl IntoElement {
    div()
        .px_2()
        .py_1()
        .rounded(radius)
        .bg(color.opacity(0.14))
        .text_color(color)
        .text_xs()
        .child(text)
}

fn callout(text: &str, color: Hsla, radius: Pixels) -> impl IntoElement {
    div()
        .w_full()
        .p_3()
        .rounded(radius)
        .bg(color.opacity(0.12))
        .text_color(color)
        .text_sm()
        .child(text.to_string())
}

fn sponsor_card(
    src: &'static str,
    caption: &'static str,
    width: f32,
    height: f32,
    theme: &Theme,
) -> impl IntoElement + use<> {
    v_flex()
        .items_center()
        .gap_2()
        .child(
            div()
                .p_3()
                .rounded(theme.radius)
                .bg(white())
                .border_1()
                .border_color(theme.border)
                .child(
                    img(src)
                        .w(px(width))
                        .h(px(height))
                        .object_fit(ObjectFit::Contain),
                ),
        )
        .child(
            div()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(caption),
        )
}

fn jobs_panel(
    jobs: &[JobSnapshot],
    center: Entity<JobCenter>,
    theme: &Theme,
    s: &Strings,
) -> AnyElement {
    if jobs.is_empty() {
        return div().into_any_element();
    }
    let rows = jobs
        .iter()
        .take(3)
        .map(|job| job_row(job, center.clone(), theme, s))
        .collect::<Vec<_>>();
    GroupBox::new()
        .id("jobs-panel")
        .outline()
        .title(s.jobs)
        .child(v_flex().gap_3().children(rows))
        .into_any_element()
}

fn job_row(job: &JobSnapshot, center: Entity<JobCenter>, theme: &Theme, s: &Strings) -> AnyElement {
    let muted = theme.muted_foreground;
    let border = theme.border;
    let (status, color) = match job.status {
        JobStatus::Running => (s.job_running, theme.primary),
        JobStatus::Succeeded => (s.job_succeeded, theme.success),
        JobStatus::Failed => (s.job_failed, theme.danger),
        JobStatus::Canceled => (s.job_canceled, muted),
    };
    let bar = match job.progress {
        Some(fraction) => div()
            .h(px(4.))
            .w_full()
            .rounded(px(2.))
            .bg(border)
            .child(
                div()
                    .h_full()
                    .w(relative(fraction.clamp(0.0, 1.0)))
                    .rounded(px(2.))
                    .bg(color),
            )
            .into_any_element(),
        None => div().into_any_element(),
    };
    let percent = job
        .progress
        .map(|fraction| format!("{:.0}%", fraction * 100.0))
        .unwrap_or_default();
    let elapsed = job.started.elapsed().as_secs();
    let detail = if percent.is_empty() {
        format!("{elapsed}s")
    } else {
        format!("{percent} · {elapsed}s")
    };
    let log_line = match job.log.last().filter(|line| line.as_str() != job.message) {
        Some(line) => div()
            .text_xs()
            .text_color(muted)
            .child(line.clone())
            .into_any_element(),
        None => div().into_any_element(),
    };
    let mut footer = h_flex()
        .items_center()
        .justify_between()
        .child(div().text_xs().text_color(muted).child(detail));
    if job.status.is_running() {
        let center = center.clone();
        let id = job.id;
        footer = footer.child(
            Button::new(SharedString::from(format!("job-cancel-{id}")))
                .label(s.cancel)
                .compact()
                .on_click(move |_, _, cx| {
                    center.update(cx, |center, cx| {
                        center.cancel(id);
                        cx.notify();
                    });
                }),
        );
    }

    v_flex()
        .gap_2()
        .p_3()
        .rounded(theme.radius)
        .border_1()
        .border_color(border)
        .child(
            h_flex()
                .items_center()
                .justify_between()
                .child(div().text_sm().child(job.title.clone()))
                .child(div().text_xs().text_color(color).child(status)),
        )
        .child(div().text_xs().text_color(muted).child(job.message.clone()))
        .child(log_line)
        .child(bar)
        .child(footer)
        .into_any_element()
}

fn pack_row(
    label: &'static str,
    detail: String,
    ready: bool,
    target: Page,
    entity: Entity<VSynthApp>,
    theme: &Theme,
    s: &Strings,
) -> impl IntoElement {
    let color = if ready { theme.success } else { theme.danger };
    h_flex()
        .justify_between()
        .items_center()
        .gap_4()
        .py_1()
        .border_b_1()
        .border_color(theme.border)
        .child(
            v_flex().gap_1().child(div().text_sm().child(label)).child(
                div()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(detail),
            ),
        )
        .child(
            h_flex()
                .items_center()
                .gap_2()
                .child(announce_badge(
                    if ready { s.ready } else { s.missing },
                    color,
                    theme.radius,
                ))
                .child(
                    Button::new(SharedString::from(format!("pack-open-{}", target.id())))
                        .label(s.open_page)
                        .compact()
                        .on_click(move |_, window, cx| {
                            entity.update(cx, |this, cx| this.set_page(target, window, cx));
                        }),
                ),
        )
}
