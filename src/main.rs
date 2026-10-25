#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::TitleBar;
use gpui_kit::*;

struct VSynthStudio;

impl Render for VSynthStudio {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .size_full()
            .child(
                TitleBar::new().child(
                    div()
                        .flex()
                        .items_center()
                        .child("V-Synth-Studio"),
                ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .items_center()
                    .justify_center()
                    .gap_2()
                    .child("Hello, World!")
                    .child(
                        Button::new("hello")
                            .primary()
                            .label("Click me")
                            .on_click(|_, _, _| println!("Clicked!")),
                    ),
            )
    }
}

fn main() {
    application()
        .with_assets(assets::Assets)
        .run(|cx| {
            init(cx);
            let bounds = Bounds::centered(None, size(px(800.), px(600.)), cx);
            let window_options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..TitleBar::window_options()
            };
            open_window(window_options, cx, |_, cx| {
                cx.new(|_| VSynthStudio)
            })
            .expect("Failed to open window");
        });
}