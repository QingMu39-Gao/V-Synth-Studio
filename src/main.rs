#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod app_assets;
mod config;
mod jizura;
mod jizura_save;
mod pages;
mod resources;
mod tools;

use gpui_kit::component::TitleBar;
use gpui_kit::component::input::InputState;
use gpui_kit::*;

fn main() {
    let config = config::Config::load();
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
                let resource_search =
                    cx.new(|cx| InputState::new(window, cx).placeholder("搜索名称、描述、标签…"));
                let view = cx.new(|_| {
                    app::VSynthApp::new(
                        config.clone(),
                        output_input,
                        download_input,
                        ext_input,
                        resource_search,
                    )
                });
                view.update(cx, |this, cx| {
                    this.watch_system_theme(window, cx);
                    this.watch_resource_search(cx);
                    this.refresh_tools(cx);
                });
                view
            })
            .expect("Failed to open window");
        });
}
