use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::group_box::{GroupBox, GroupBoxVariants as _};
use gpui_kit::component::{ActiveTheme as _, Icon, Theme, ThemeMode, TitleBar, h_flex, v_flex};
use gpui_kit::*;

use crate::config::{Config, ThemePreference};
use crate::pages::Page;
use crate::tools::{Tool, ToolStatus};

const SIDEBAR_WIDTH: f32 = 228.0;

pub struct VSynthApp {
    page: Page,
    config: Config,
    notice: Option<String>,
    tools: Option<ToolStatus>,
    scanning_tools: bool,
}

impl VSynthApp {
    pub fn new(config: Config) -> Self {
        Self {
            page: Page::Dashboard,
            config,
            notice: None,
            tools: None,
            scanning_tools: false,
        }
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

        row.on_click(move |_, _, cx| {
            entity.update(cx, |this, cx| {
                this.page = page;
                cx.notify();
            });
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

    fn render_main(&self, cx: &mut Context<Self>) -> impl IntoElement {
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

        main.child(self.render_page(cx))
    }

    fn render_page(&self, cx: &mut Context<Self>) -> AnyElement {
        match self.page {
            Page::Dashboard => self.render_dashboard(cx).into_any_element(),
            Page::Settings => self.render_settings(cx).into_any_element(),
            _ => self.render_placeholder(cx).into_any_element(),
        }
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
        let refresh_button = Button::new("tools-refresh")
            .label(if self.scanning_tools {
                "检测中…"
            } else {
                "重新检测"
            })
            .on_click({
                let entity = entity.clone();
                move |_, _, cx| {
                    entity.update(cx, |this, cx| this.refresh_tools(cx));
                }
            });

        let quick_buttons = Page::ALL
            .into_iter()
            .filter(|page| !matches!(page, Page::Dashboard | Page::Settings))
            .map(|page| {
                let entity = entity.clone();
                Button::new(SharedString::from(format!("quick-{}", page.id())))
                    .label(page.title())
                    .on_click(move |_, _, cx| {
                        entity.update(cx, |this, cx| {
                            this.page = page;
                            cx.notify();
                        });
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
                            h_flex().items_center().gap_3().child(refresh_button).child(
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
                        .gap_1()
                        .child(info_row(
                            "输出目录",
                            configured_path(&self.config.output_dir, "默认（系统下载目录）"),
                            muted,
                            border,
                        ))
                        .child(info_row(
                            "下载目录",
                            configured_path(&self.config.download_dir, "默认（系统下载目录）"),
                            muted,
                            border,
                        ))
                        .child(info_row(
                            "扩展包目录",
                            configured_path(&self.config.ext_dir, "默认（data 目录）"),
                            muted,
                            border,
                        ))
                        .child(info_row("工具目录", tools_dir_display(), muted, border))
                        .child(
                            div()
                                .text_xs()
                                .text_color(muted)
                                .child("路径编辑将在下一批接入；当前只读取旧配置。"),
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
                GroupBox::new().outline().title("迁移状态").child(
                    v_flex()
                        .gap_2()
                        .child(bullet_line("设置页已接入外观、配置与路径读取"))
                        .child(bullet_line(
                            "路径编辑、外部工具启动、公告、赞助、关于尚未迁移",
                        ))
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

fn configured_path(value: &str, fallback: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        fallback.to_string()
    } else {
        value.to_string()
    }
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
