#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod app_assets;
mod config;
mod formats;
mod i18n;
mod jizura;
mod jizura_save;
mod jobs;
mod logging;
mod pages;
mod resources;
mod services;
mod tools;

use gpui_kit::component::TitleBar;
use gpui_kit::component::input::{InputState, TextareaState};
use gpui_kit::*;

fn main() {
    let config = config::Config::load();
    i18n::set_language(config.language);
    config::set_extensions_root(&config.ext_dir);
    logging::init();
    let initial_theme = config.theme;

    application()
        .with_assets(app_assets::AppAssets)
        .run(move |cx| {
            init(cx);

            let bounds = Bounds::centered(None, size(px(1360.), px(880.)), cx);
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                window_min_size: Some(size(px(960.), px(640.))),
                ..TitleBar::window_options()
            };

            open_window(options, cx, move |window, cx| {
                app::apply_theme(initial_theme, window, cx);
                let output_input = cx
                    .new(|cx| InputState::new(window, cx).default_value(config.output_dir.clone()));
                let download_input = cx.new(|cx| {
                    InputState::new(window, cx).default_value(config.download_dir.clone())
                });
                let ext_input =
                    cx.new(|cx| InputState::new(window, cx).default_value(config.ext_dir.clone()));
                let resource_search = cx.new(|cx| {
                    InputState::new(window, cx)
                        .placeholder(i18n::strings(config.language).search_placeholder)
                });
                let video_url_input = cx.new(|cx| {
                    InputState::new(window, cx)
                        .placeholder(i18n::strings(config.language).video_url_placeholder)
                });
                let lyrics_query = cx.new(|cx| {
                    InputState::new(window, cx)
                        .placeholder(i18n::strings(config.language).lyrics_query_placeholder)
                });
                let lyrics_editor = cx.new(|cx| TextareaState::new(window, cx));
                let job_center = cx.new(jobs::JobCenter::new);
                let inputs = app::AppInputs {
                    output: output_input,
                    download: download_input,
                    ext: ext_input,
                    resource_search,
                    video_url: video_url_input,
                    lyrics_query,
                    lyrics_editor,
                };
                let view = cx.new(|_| app::VSynthApp::new(config.clone(), inputs, job_center));
                view.update(cx, |this, cx| {
                    this.watch_system_theme(window, cx);
                    this.watch_resource_search(cx);
                    this.refresh_tools(cx);
                    this.refresh_announcements(cx);
                    this.check_updates(true, cx);
                });
                view
            })
            .expect("Failed to open window");
        });
}
