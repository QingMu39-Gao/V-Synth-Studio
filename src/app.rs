use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::group_box::{GroupBox, GroupBoxVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{ActiveTheme as _, Icon, Theme, ThemeMode, TitleBar, h_flex, v_flex};
use gpui_kit::*;

use std::path::{Path, PathBuf};

use gpui_webview::WebView;

use crate::config::{Config, ThemePreference};
use crate::formats::{self, Format};
use crate::i18n::{self, Language, Strings};
use crate::jobs::JobCenter;
use crate::pages::Page;
use crate::resources::{Group, Item, Resources};
use crate::services::artifacts::{self, Artifact};
use crate::services::jobs::{JobOutcome, JobSnapshot, JobStatus};
use crate::services::libresvip::{self, ProjectInfo};
use crate::tools::{Tool, ToolStatus};

const WEBVIEW_DEMO: &str = include_str!("webview_demo.html");

const SIDEBAR_WIDTH: f32 = 228.0;

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
    job_center: Entity<JobCenter>,
    tool_job: Option<u64>,
    component_job: Option<(&'static str, u64)>,
    convert_inputs: Vec<PathBuf>,
    convert_format: &'static Format,
    convert_preview: Option<(PathBuf, ProjectInfo)>,
    convert_preview_job: Option<u64>,
    convert_job: Option<u64>,
    convert_notice: Option<String>,
}

impl VSynthApp {
    fn text(&self) -> &'static Strings {
        i18n::strings(self.config.language)
    }

    pub fn new(
        config: Config,
        output_input: Entity<InputState>,
        download_input: Entity<InputState>,
        ext_input: Entity<InputState>,
        resource_search: Entity<InputState>,
        job_center: Entity<JobCenter>,
    ) -> Self {
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
            output_input,
            download_input,
            ext_input,
            resources,
            resource_error,
            resource_search,
            resource_group: None,
            webview: None,
            webview_error: None,
            webview_source: None,
            job_center,
            tool_job: None,
            component_job: None,
            convert_inputs: Vec::new(),
            convert_format: formats::DEFAULT,
            convert_preview: None,
            convert_preview_job: None,
            convert_job: None,
            convert_notice: None,
        }
    }

    fn set_page(&mut self, page: Page, window: &mut Window, cx: &mut Context<Self>) {
        if self.page == Page::Pv
            && page != Page::Pv
            && let Some(webview) = &self.webview
        {
            webview.update(cx, |webview, _| webview.hide());
        }
        if page == Page::Pv {
            self.ensure_webview(window, cx);
            if let Some(webview) = &self.webview {
                webview.update(cx, |webview, _| webview.show());
            }
        }
        self.page = page;
        cx.notify();
    }

    fn ensure_webview(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.webview.is_some() || self.webview_error.is_some() {
            return;
        }
        let jizura_root = crate::jizura::asset_dir();
        let has_jizura = jizura_root.is_some();
        let s = self.text();
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
        if has_jizura {
            builder = builder.with_initialization_script(crate::jizura::save_bridge_script());
        }
        match WebView::build(builder, window, cx) {
            Ok(webview) => self.webview = Some(cx.new(|_| webview)),
            Err(error) => {
                self.webview_error = Some(format!("{}：{error}", s.webview_failed));
            }
        }
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

    fn refresh_tools_button(&self, cx: &mut Context<Self>) -> AnyElement {
        let entity = cx.entity();
        let s = self.text();
        let running = self
            .tool_job
            .is_some_and(|id| self.job_center.read(cx).is_running(id));
        let label = if running {
            s.cancel
        } else if self.scanning_tools {
            s.checking
        } else {
            s.refresh_tools
        };
        let tool_job = self.tool_job;
        Button::new("tools-refresh")
            .label(label)
            .on_click(move |_, _, cx| {
                entity.update(cx, |this, cx| {
                    if running {
                        if let Some(id) = tool_job {
                            this.job_center.read(cx).cancel(id);
                        }
                    } else {
                        this.refresh_tools(cx);
                    }
                    cx.notify();
                });
            })
            .into_any_element()
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

    fn install_component(&mut self, artifact: Artifact, cx: &mut Context<Self>) {
        if self
            .component_job
            .is_some_and(|(_, id)| self.job_center.read(cx).is_running(id))
        {
            return;
        }
        let root = crate::config::app_root();
        let title = format!("{} {}", self.text().install_job, artifact.name);
        let job = self.job_center.read(cx).start(title, move |ctx| {
            crate::services::artifacts::install(&artifact, &root, &ctx)
        });
        self.component_job = Some((artifact.id, job.id));
        let job_id = job.id;
        let artifact_id = artifact.id;
        cx.spawn(async move |this, cx| {
            let outcome = job.result.recv().await;
            let Some(this) = this.upgrade() else {
                return;
            };
            this.update(cx, |this, cx| {
                if this.component_job == Some((artifact_id, job_id)) {
                    this.component_job = None;
                }
                match outcome {
                    Ok(JobOutcome::Done(())) => this.notice = None,
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

    fn cancel_component(&mut self, cx: &mut Context<Self>) {
        if let Some((_, id)) = self.component_job {
            self.job_center.read(cx).cancel(id);
            cx.notify();
        }
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
        if self.page == Page::Pv {
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
            Page::Settings => self.render_settings(cx).into_any_element(),
            Page::Resources => self.render_resources(cx).into_any_element(),
            Page::Pv => self.render_pv(cx),
            _ => self.render_placeholder(cx).into_any_element(),
        }
    }

    fn render_pv(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let muted = theme.muted_foreground;
        let danger = theme.danger;
        let border = theme.border;
        let radius = theme.radius;
        let entity = cx.entity();

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
                            entity.update(cx, |this, cx| this.ensure_webview(window, cx));
                        }),
                )
                .into_any_element()
        };

        let mut page =
            v_flex()
                .size_full()
                .p_6()
                .gap_3()
                .child(page_header(self.page, muted, self.text()));
        if let Some(source) = self.webview_source.clone() {
            page = page.child(div().text_xs().text_color(muted).child(source));
        }
        page.child(body).into_any_element()
    }

    fn render_dashboard(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let jobs = self.job_center.read(cx).snapshots().to_vec();
        let theme = cx.theme();
        let muted = theme.muted_foreground;
        let border = theme.border;
        let entity = cx.entity();
        let s = self.text();

        let tools_ready = match self.tools.as_ref() {
            Some(tools) => format!("{}/3 {}", tools.ready_count(), s.ready),
            None if self.scanning_tools => s.checking.to_string(),
            None => s.unchecked.to_string(),
        };

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
                            .child(info_row(s.external_tools, tools_ready, muted, border)),
                    ),
            )
            .child(
                GroupBox::new()
                    .id("dashboard-tools")
                    .outline()
                    .title(s.external_tools)
                    .child(
                        v_flex()
                            .gap_2()
                            .child(tool_row(
                                "ffmpeg",
                                self.tools.as_ref().map(|tools| &tools.ffmpeg),
                                self.scanning_tools,
                                theme,
                                s,
                            ))
                            .child(tool_row(
                                "yt-dlp",
                                self.tools.as_ref().map(|tools| &tools.ytdlp),
                                self.scanning_tools,
                                theme,
                                s,
                            ))
                            .child(tool_row(
                                "python",
                                self.tools.as_ref().map(|tools| &tools.python),
                                self.scanning_tools,
                                theme,
                                s,
                            ))
                            .child(
                                h_flex()
                                    .items_center()
                                    .gap_3()
                                    .child(self.refresh_tools_button(cx))
                                    .child(div().text_xs().text_color(muted).child(format!(
                                        "{}: {}",
                                        s.tools_dir,
                                        tools_dir_display()
                                    ))),
                            ),
                    ),
            )
            .child(jobs_element)
            .child(
                GroupBox::new()
                    .id("dashboard-quick")
                    .title(s.quick_entry)
                    .child(h_flex().gap_2().flex_wrap().children(quick_buttons)),
            )
    }

    fn render_convert(&self, cx: &mut Context<Self>) -> AnyElement {
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
        let refresh_button = self.refresh_tools_button(cx);
        let sponsor_theme = cx.theme();
        let entity = cx.entity();
        let component_running = self
            .component_job
            .is_some_and(|(_, id)| self.job_center.read(cx).is_running(id));
        let component_job = self.component_job;
        let root = crate::config::app_root();
        let component_theme = cx.theme();
        let component_rows = if artifacts::ALL.is_empty() {
            vec![
                div()
                    .text_sm()
                    .text_color(muted)
                    .child(s.no_components)
                    .into_any_element(),
            ]
        } else {
            artifacts::ALL
                .iter()
                .map(|artifact| {
                    let active = component_job.is_some_and(|(id, _)| id == artifact.id);
                    component_row(
                        artifact,
                        &root,
                        active,
                        component_running,
                        entity.clone(),
                        component_theme,
                        s,
                    )
                })
                .collect::<Vec<_>>()
        };

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
            .child(
                GroupBox::new()
                    .id("settings-tools")
                    .outline()
                    .title(s.external_tools)
                    .child(
                        v_flex()
                            .gap_2()
                            .child(tool_row(
                                "ffmpeg",
                                self.tools.as_ref().map(|tools| &tools.ffmpeg),
                                self.scanning_tools,
                                cx.theme(),
                                s,
                            ))
                            .child(tool_row(
                                "yt-dlp",
                                self.tools.as_ref().map(|tools| &tools.ytdlp),
                                self.scanning_tools,
                                cx.theme(),
                                s,
                            ))
                            .child(tool_row(
                                "python",
                                self.tools.as_ref().map(|tools| &tools.python),
                                self.scanning_tools,
                                cx.theme(),
                                s,
                            ))
                            .child(h_flex().items_center().gap_3().child(refresh_button).child(
                                div().text_xs().text_color(muted).child(format!(
                                    "{}: {}",
                                    s.tools_dir,
                                    tools_dir_display()
                                )),
                            ))
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(muted)
                                    .child(s.missing_tools_hint),
                            ),
                    ),
            )
            .child(
                GroupBox::new()
                    .id("settings-components")
                    .outline()
                    .title(s.components)
                    .child(
                        v_flex()
                            .gap_2()
                            .children(component_rows)
                            .child(div().text_xs().text_color(muted).child(s.component_hint)),
                    ),
            )
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

    fn render_placeholder(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let muted = theme.muted_foreground;
        let entity = cx.entity();
        let s = self.text();

        v_flex()
            .gap_4()
            .child(page_header(self.page, muted, self.text()))
            .child(
                GroupBox::new()
                    .id("placeholder")
                    .outline()
                    .title(s.under_development)
                    .child(
                        v_flex()
                            .gap_2()
                            .child(div().text_sm().child(s.not_implemented))
                            .child(h_flex().child(
                                Button::new("placeholder-back").label(s.back).on_click(
                                    move |_, _, cx| {
                                        entity.update(cx, |this, cx| {
                                            this.page = Page::Dashboard;
                                            cx.notify();
                                        });
                                    },
                                ),
                            )),
                    ),
            )
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

fn theme_label(preference: ThemePreference, s: &Strings) -> &'static str {
    match preference {
        ThemePreference::System => s.theme_system,
        ThemePreference::Light => s.theme_light,
        ThemePreference::Dark => s.theme_dark,
    }
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

fn component_row(
    artifact: &Artifact,
    root: &Path,
    active: bool,
    any_running: bool,
    entity: Entity<VSynthApp>,
    theme: &Theme,
    s: &Strings,
) -> AnyElement {
    let muted = theme.muted_foreground;
    let installed = artifact.is_installed(root);
    let (status, color) = if active {
        (s.installing, theme.primary)
    } else if installed {
        (s.installed, theme.success)
    } else {
        (s.not_installed, theme.danger)
    };
    let detail = if active {
        s.install_running.to_string()
    } else if installed {
        format!(
            "v{} · tools/{}/{}",
            artifact.version, artifact.id, artifact.executable
        )
    } else {
        format!(
            "v{} · {:.1} MB · {}",
            artifact.version,
            artifact.size as f64 / 1_000_000.0,
            s.download_source
        )
    };
    let label = if active {
        s.cancel_install
    } else if any_running {
        s.installing
    } else if installed {
        s.reinstall
    } else {
        s.install
    };
    let artifact = *artifact;
    let mut button =
        Button::new(SharedString::from(format!("component-{}", artifact.id))).label(label);
    if !active && !any_running && !installed {
        button = button.primary();
    }
    let button = button.on_click(move |_, _, cx| {
        entity.update(cx, |this, cx| {
            if active {
                this.cancel_component(cx);
            } else if !any_running {
                this.install_component(artifact, cx);
            }
        });
    });

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
                .child(div().text_sm().child(artifact.name))
                .child(div().text_xs().text_color(muted).child(detail)),
        )
        .child(
            h_flex()
                .items_center()
                .gap_2()
                .child(
                    div()
                        .px_2()
                        .py_1()
                        .rounded(theme.radius)
                        .bg(color.opacity(0.14))
                        .text_color(color)
                        .text_xs()
                        .child(status),
                )
                .child(button),
        )
        .into_any_element()
}

fn tool_row(
    label: &'static str,
    tool: Option<&Tool>,
    scanning: bool,
    theme: &Theme,
    s: &Strings,
) -> impl IntoElement {
    let muted = theme.muted_foreground;
    let (status, color, detail) = match tool {
        Some(tool) if tool.available => (
            s.available,
            theme.success,
            tool.version
                .clone()
                .or_else(|| tool.path.clone())
                .unwrap_or_else(|| s.found_executable.to_string()),
        ),
        Some(_) => (s.missing, theme.danger, s.not_found.to_string()),
        None if scanning => (s.scanning, muted, s.scanning_hint.to_string()),
        None => (s.unchecked, muted, s.waiting_check.to_string()),
    };

    h_flex()
        .justify_between()
        .items_center()
        .gap_4()
        .py_1()
        .border_b_1()
        .border_color(theme.border)
        .child(
            v_flex()
                .gap_1()
                .child(div().text_sm().child(label))
                .child(div().text_xs().text_color(muted).child(detail)),
        )
        .child(
            div()
                .px_2()
                .py_1()
                .rounded(theme.radius)
                .bg(color.opacity(0.14))
                .text_color(color)
                .text_xs()
                .child(status),
        )
}
