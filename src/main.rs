#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod config;
mod pages;

use gpui_kit::component::TitleBar;
use gpui_kit::*;

fn main() {
    let config = config::Config::load();
    let initial_theme = config.theme;

    application().with_assets(assets::AllAssets).run(move |cx| {
        init(cx);

        let bounds = Bounds::centered(None, size(px(1360.), px(880.)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            window_min_size: Some(size(px(960.), px(640.))),
            ..TitleBar::window_options()
        };

        open_window(options, cx, move |window, cx| {
            app::apply_theme(initial_theme, window, cx);
            let view = cx.new(|_| app::VSynthApp::new(config.clone()));
            view.update(cx, |this, cx| this.watch_system_theme(window, cx));
            view
        })
        .expect("Failed to open window");
    });
}
