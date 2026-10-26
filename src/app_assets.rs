//! gpui-kit 的图标资源 + 程序自己的图片。
//!
//! GPUI 只接受一个 `AssetSource`，所以这里把赞助码嵌进二进制，其它路径继续交给
//! gpui-kit 的 `AllAssets`。

use std::borrow::Cow;

use gpui_kit::assets::AllAssets;
use gpui_kit::{AssetSource, Result, SharedString};

const SPONSOR: &[u8] = include_bytes!("../assets/img/sponsor.jpg");
const SPONSOR_ALIPAY: &[u8] = include_bytes!("../assets/img/sponsor-alipay.jpg");
const OWN_ASSETS: [&str; 2] = ["img/sponsor.jpg", "img/sponsor-alipay.jpg"];

#[derive(Clone, Copy, Debug, Default)]
pub struct AppAssets;

impl AssetSource for AppAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        match path {
            "img/sponsor.jpg" => Ok(Some(Cow::Borrowed(SPONSOR))),
            "img/sponsor-alipay.jpg" => Ok(Some(Cow::Borrowed(SPONSOR_ALIPAY))),
            _ => AllAssets.load(path),
        }
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut items = AllAssets.list(path)?;
        for asset in OWN_ASSETS {
            if asset.starts_with(path) {
                items.push(asset.into());
            }
        }
        Ok(items)
    }
}
