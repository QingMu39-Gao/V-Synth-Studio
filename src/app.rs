use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::group_box::{GroupBox, GroupBoxVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{ActiveTheme as _, Icon, Theme, ThemeMode, TitleBar, h_flex, v_flex};
use gpui_kit::*;

use gpui_webview::WebView;

use crate::config::{Config, ThemePreference};
use crate::pages::Page;
use crate::resources::{Group, Item, Resources};
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
}

impl VSynthApp {
    pub fn new(
        config: Config,
        output_input: Entity<InputState>,
        download_input: Entity<InputState>,
        ext_input: Entity<InputState>,
        resource_search: Entity<InputState>,
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
        let builder = match crate::jizura::asset_dir() {
            Some(root) => {
                self.webview_source = Some("JIZURA · custom protocol".to_string());
                wry::WebViewBuilder::new()
                    .with_custom_protocol(crate::jizura::SCHEME.into(), move |_, request| {
                        crate::jizura::serve(&root, request)
                    })
                    .with_url(crate::jizura::START_URL)
            }
            None => {
                self.webview_source = Some("WebView 验证页（未找到 JIZURA 资源）".to_string());
                wry::WebViewBuilder::new().with_html(WEBVIEW_DEMO)
            }
        };
        match WebView::build(builder, window, cx) {
            Ok(webview) => self.webview = Some(cx.new(|_| webview)),
            Err(error) => self.webview_error = Some(format!("创建 WebView 失败：{error}")),
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
        Button::new("tools-refresh")
            .label(if self.scanning_tools {
                "检测中…"
            } else {
                "重新检测"
            })
            .on_click(move |_, _, cx| {
                entity.update(cx, |this, cx| this.refresh_tools(cx));
            })
            .into_any_element()
    }

    pub fn refresh_tools(&mut self, cx: &mut Context<Self>) {
        if self.scanning_tools {
            return;
        }
        self.scanning_tools = true;
        let root = crate::config::app_root();
        cx.spawn(async move |this, cx| {
            let status = cx
                .background_spawn(async move { crate::tools::detect(&root) })
                .await;
            if let Some(this) = this.upgrade() {
                this.update(cx, |this, cx| {
                    this.tools = Some(status);
                    this.scanning_tools = false;
                    cx.notify();
                });
            }
        })
        .detach();
        cx.notify();
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

        let mut items = Vec::new();
        let mut last_group = "";
        for page in Page::ALL {
            if page.group() != last_group {
                last_group = page.group();
                items.push(
                    div()
                        .pt_3()
                        .pb_1()
                        .px_2()
                        .text_xs()
                        .text_color(muted)
                        .child(page.group())
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
                    .child(div().text_xs().text_color(muted).child("主题"))
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
            .child(div().text_sm().child(page.title()));

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
        let label = if compact {
            preference.short_label()
        } else {
            preference.label()
        };

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
                        .label("打开文字 PV 编辑器")
                        .primary()
                        .on_click(move |_, window, cx| {
                            entity.update(cx, |this, cx| this.ensure_webview(window, cx));
                        }),
                )
                .into_any_element()
        };

        let mut page = v_flex()
            .size_full()
            .p_6()
            .gap_3()
            .child(page_header(self.page, muted));
        if let Some(source) = self.webview_source.clone() {
            page = page.child(div().text_xs().text_color(muted).child(source));
        }
        page.child(body).into_any_element()
    }

    fn render_dashboard(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let muted = theme.muted_foreground;
        let border = theme.border;
        let entity = cx.entity();

        let tools_ready = self
            .tools
            .as_ref()
            .map(ToolStatus::ready_count)
            .map(|count| format!("{count}/3 就绪"))
            .unwrap_or_else(|| "检测中…".to_string());

        let quick_buttons = Page::ALL
            .into_iter()
            .filter(|page| !matches!(page, Page::Dashboard | Page::Settings))
            .map(|page| {
                let entity = entity.clone();
                Button::new(SharedString::from(format!("quick-{}", page.id())))
                    .label(page.title())
                    .on_click(move |_, window, cx| {
                        entity.update(cx, |this, cx| this.set_page(page, window, cx));
                    })
                    .into_any_element()
            })
            .collect::<Vec<_>>();

        v_flex()
            .gap_4()
            .child(page_header(self.page, muted))
            .child(
                GroupBox::new().outline().title("运行环境").child(
                    v_flex()
                        .gap_1()
                        .child(info_row(
                            "版本",
                            env!("CARGO_PKG_VERSION").to_string(),
                            muted,
                            border,
                        ))
                        .child(info_row(
                            "平台",
                            format!("{} / {}", std::env::consts::OS, std::env::consts::ARCH),
                            muted,
                            border,
                        ))
                        .child(info_row("配置", config_path_display(), muted, border))
                        .child(info_row(
                            "主题",
                            self.config.theme.label().to_string(),
                            muted,
                            border,
                        ))
                        .child(info_row(
                            "界面框架",
                            "gpui-kit 0.8".to_string(),
                            muted,
                            border,
                        ))
                        .child(info_row("外部工具", tools_ready, muted, border)),
                ),
            )
            .child(
                GroupBox::new().outline().title("外部工具").child(
                    v_flex()
                        .gap_2()
                        .child(tool_row(
                            "ffmpeg",
                            self.tools.as_ref().map(|tools| &tools.ffmpeg),
                            self.scanning_tools,
                            theme,
                        ))
                        .child(tool_row(
                            "yt-dlp",
                            self.tools.as_ref().map(|tools| &tools.ytdlp),
                            self.scanning_tools,
                            theme,
                        ))
                        .child(tool_row(
                            "python",
                            self.tools.as_ref().map(|tools| &tools.python),
                            self.scanning_tools,
                            theme,
                        ))
                        .child(
                            h_flex()
                                .items_center()
                                .gap_3()
                                .child(self.refresh_tools_button(cx))
                                .child(
                                    div()
                                        .text_xs()
                                        .text_color(muted)
                                        .child(format!("目录：{}", tools_dir_display())),
                                ),
                        ),
                ),
            )
            .child(
                GroupBox::new().outline().title("迁移进度").child(
                    v_flex()
                        .gap_2()
                        .child(bullet_line(
                            "已完成：GPUI 外壳、导航、主题与配置、外部工具检测",
                        ))
                        .child(bullet_line(
                            "下一步：路径编辑、设置分节、任务状态与页面业务",
                        ))
                        .child(bullet_line("待迁：视频预览、波形编辑、文字 PV、安装更新")),
                ),
            )
            .child(
                GroupBox::new()
                    .title("快速入口")
                    .child(h_flex().gap_2().flex_wrap().children(quick_buttons)),
            )
    }

    fn render_settings(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let muted = theme.muted_foreground;
        let border = theme.border;
        let entity = cx.entity();
        let theme_buttons = ThemePreference::ALL
            .into_iter()
            .map(|preference| self.render_theme_button(preference, false, cx))
            .collect::<Vec<_>>();
        let refresh_button = self.refresh_tools_button(cx);

        v_flex()
            .gap_4()
            .child(page_header(self.page, muted))
            .child(
                GroupBox::new().outline().title("外观").child(
                    v_flex()
                        .gap_3()
                        .child(div().text_sm().child("主题"))
                        .child(h_flex().gap_2().children(theme_buttons))
                        .child(
                            div()
                                .text_xs()
                                .text_color(muted)
                                .child("选择后立即应用，并写入 data/config.json。"),
                        ),
                ),
            )
            .child(
                GroupBox::new().outline().title("路径").child(
                    v_flex()
                        .gap_3()
                        .child(path_field(
                            "输出目录",
                            &self.output_input,
                            "留空 = 系统下载目录",
                            muted,
                        ))
                        .child(path_field(
                            "下载目录",
                            &self.download_input,
                            "留空 = 系统下载目录",
                            muted,
                        ))
                        .child(path_field(
                            "扩展包目录",
                            &self.ext_input,
                            "留空 = data 目录；扩展包体积大，建议换到别的盘",
                            muted,
                        ))
                        .child(info_row("工具目录", tools_dir_display(), muted, border))
                        .child(
                            h_flex()
                                .items_center()
                                .gap_3()
                                .child(
                                    Button::new("save-paths")
                                        .label("保存路径")
                                        .primary()
                                        .on_click({
                                            let entity = cx.entity();
                                            move |_, _, cx| {
                                                entity.update(cx, |this, cx| this.save_paths(cx));
                                            }
                                        }),
                                )
                                .child(
                                    div()
                                        .text_xs()
                                        .text_color(muted)
                                        .child("保存后写入 data/config.json。"),
                                ),
                        ),
                ),
            )
            .child(
                GroupBox::new().outline().title("外部工具").child(
                    v_flex()
                        .gap_2()
                        .child(tool_row(
                            "ffmpeg",
                            self.tools.as_ref().map(|tools| &tools.ffmpeg),
                            self.scanning_tools,
                            cx.theme(),
                        ))
                        .child(tool_row(
                            "yt-dlp",
                            self.tools.as_ref().map(|tools| &tools.ytdlp),
                            self.scanning_tools,
                            cx.theme(),
                        ))
                        .child(tool_row(
                            "python",
                            self.tools.as_ref().map(|tools| &tools.python),
                            self.scanning_tools,
                            cx.theme(),
                        ))
                        .child(
                            h_flex()
                                .items_center()
                                .gap_3()
                                .child(refresh_button)
                                .child(
                                    div()
                                        .text_xs()
                                        .text_color(muted)
                                        .child(format!("目录：{}", tools_dir_display())),
                                ),
                        )
                        .child(
                            div()
                                .text_xs()
                                .text_color(muted)
                                .child("缺少 ffmpeg / yt-dlp 时，音频与下载相关功能不可用；请重新解压程序包补齐 tools/。"),
                        ),
                ),
            )
            .child(
                GroupBox::new().outline().title("配置").child(
                    v_flex()
                        .gap_1()
                        .child(info_row("文件", config_path_display(), muted, border))
                        .child(info_row(
                            "当前主题",
                            self.config.theme.label().to_string(),
                            muted,
                            border,
                        ))
                        .child(info_row(
                            "语言",
                            "简体中文（待移植 i18n）".to_string(),
                            muted,
                            border,
                        )),
                ),
            )
            .child(
                GroupBox::new().outline().title("关于").child(
                    v_flex()
                        .gap_1()
                        .child(info_row(
                            "程序版本",
                            env!("CARGO_PKG_VERSION").to_string(),
                            muted,
                            border,
                        ))
                        .child(info_row(
                            "运行环境",
                            format!("{} / {}", std::env::consts::OS, std::env::consts::ARCH),
                            muted,
                            border,
                        ))
                        .child(info_row("许可证", "GPL-3.0-only".to_string(), muted, border))
                        .child(info_row("作者", "QingMu39".to_string(), muted, border))
                        .child(
                            div()
                                .text_xs()
                                .text_color(muted)
                                .child("界面基座 gpui-kit 0.8 / GPUI；第三方组件许可见 docs/THIRD-PARTY-NOTICES.md。"),
                        ),
                ),
            )
            .child(
                GroupBox::new().outline().title("迁移状态").child(
                    v_flex()
                        .gap_2()
                        .child(bullet_line("设置页已接入外观、路径、外部工具与关于"))
                        .child(bullet_line("公告、赞助、检查更新尚未迁移"))
                        .child(h_flex().child(
                            Button::new("settings-back").label("返回总览").on_click(
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

    fn render_resources(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let muted = theme.muted_foreground;
        let border = theme.border;
        let warning = theme.warning;
        let danger = theme.danger;
        let radius = theme.radius;
        let entity = cx.entity();

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
            "全部",
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
                .map(|item| resource_card(item, &group.id, theme, entity.clone()))
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
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(muted)
                                    .child(format!("{} 条", items.len())),
                            ),
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
                "{} 条 / {} 个分组",
                self.resources.item_count(),
                self.resources.groups.len()
            )
        } else {
            format!("筛选出 {total} 条 / {} 个分组", groups.len())
        };

        let mut page = v_flex().gap_4().child(page_header(self.page, muted)).child(
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
                    .child(format!("数据更新于 {}", self.resources.updated_at)),
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
                    .child("没有匹配的资源。"),
            );
        }

        page
    }

    fn render_placeholder(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let muted = theme.muted_foreground;
        let entity = cx.entity();

        v_flex().gap_4().child(page_header(self.page, muted)).child(
            GroupBox::new().outline().title("迁移状态").child(
                v_flex()
                    .gap_2()
                    .child(div().text_sm().child("页面已接入导航与外壳。"))
                    .child(
                        div()
                            .text_sm()
                            .text_color(muted)
                            .child("React 版业务逻辑尚未迁移到这里。"),
                    )
                    .child(h_flex().child(
                        Button::new("placeholder-back").label("返回总览").on_click(
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

fn page_header(page: Page, muted: Hsla) -> impl IntoElement {
    v_flex()
        .gap_1()
        .child(
            div()
                .text_2xl()
                .font_weight(FontWeight::BOLD)
                .child(page.title()),
        )
        .child(div().text_sm().text_color(muted).child(page.subtitle()))
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
                        .label("浏览…")
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
                        .label("清空")
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
) -> AnyElement {
    let name = if item.name.trim().is_empty() {
        "未命名".to_string()
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
        .label("打开")
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
        head = head.child(pill("官方", theme.success, theme.radius));
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
                .child(format!("校验：{checked_at}")),
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

fn tool_row(
    label: &'static str,
    tool: Option<&Tool>,
    scanning: bool,
    theme: &Theme,
) -> impl IntoElement {
    let muted = theme.muted_foreground;
    let (status, color, detail) = match tool {
        Some(tool) if tool.available => (
            "可用",
            theme.success,
            tool.version
                .clone()
                .or_else(|| tool.path.clone())
                .unwrap_or_else(|| "已找到可执行文件".to_string()),
        ),
        Some(_) => (
            "缺失",
            theme.danger,
            "未在 tools/ 或 PATH 中找到".to_string(),
        ),
        None if scanning => ("检测中", muted, "正在扫描 tools/ 与 PATH".to_string()),
        None => ("未检测", muted, "等待重新检测".to_string()),
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
