//! Embeddable CPython with numpy and onnxruntime, shared by the separation and
//! transcription backends.

use std::fs;
use std::path::PathBuf;

use crate::services::download;
use crate::services::jobs::JobContext;

const PYTHON_URL: &str =
    "https://mirrors.aliyun.com/python-release/windows/python-3.10.11-embed-amd64.zip";
const PYTHON_SHA: &str = "608619f8619075629c9c69f361352a0da6ed7e62f83a0e19c63e0ea32eb7629d";
const NUMPY_URL: &str = "https://mirrors.aliyun.com/pypi/packages/19/77/538f202862b9183f54108557bfda67e17603fc560c384559e769321c9d92/numpy-1.26.4-cp310-cp310-win_amd64.whl";
const NUMPY_SHA: &str = "b97fe8060236edf3662adfc2c633f56a08ae30560c56310562cb4f95500022d5";
const ORT_URL: &str = "https://mirrors.aliyun.com/pypi/packages/3c/d8/68b63dc86b502169d017a86fe8bc718f4b0055ef1f6895bfaddd04f2eead/onnxruntime-1.19.2-cp310-cp310-win_amd64.whl";
const ORT_SHA: &str = "17ed7382d2c58d4b7354fb2b301ff30b9bf308a1c7eac9546449cd122d21cae5";

pub fn base_dir() -> PathBuf {
    crate::config::extensions_root().join("python")
}

pub fn runtime_dir() -> PathBuf {
    base_dir().join("runtime")
}

pub fn exe() -> PathBuf {
    runtime_dir().join("python.exe")
}

fn site_packages() -> PathBuf {
    runtime_dir().join("Lib").join("site-packages")
}

pub fn ready() -> bool {
    exe().is_file()
        && site_packages().join("numpy").is_dir()
        && site_packages().join("onnxruntime").is_dir()
}

pub fn ensure(ctx: &JobContext, base: f32, span: f32) -> Result<(), String> {
    if ready() {
        return Ok(());
    }
    let cache = base_dir().join("cache");
    fs::create_dir_all(&cache).map_err(|error| error.to_string())?;
    let runtime = runtime_dir();
    let _ = fs::remove_dir_all(&runtime);
    fs::create_dir_all(site_packages()).map_err(|error| error.to_string())?;

    let python_zip = cache.join("python-3.10.11-embed-amd64.zip");
    download::fetch(
        PYTHON_URL,
        &python_zip,
        PYTHON_SHA,
        0,
        base,
        span * 0.2,
        ctx,
        "Python 运行时",
    )?;
    ctx.progress(Some(base + span * 0.22), "解压 Python 运行时");
    download::extract_zip(&python_zip, &runtime)?;

    let numpy = cache.join("numpy-1.26.4-cp310-cp310-win_amd64.whl");
    download::fetch(
        NUMPY_URL,
        &numpy,
        NUMPY_SHA,
        0,
        base + span * 0.25,
        span * 0.18,
        ctx,
        "numpy",
    )?;
    ctx.progress(Some(base + span * 0.45), "安装 numpy");
    download::extract_zip(&numpy, &site_packages())?;

    let ort = cache.join("onnxruntime-1.19.2-cp310-cp310-win_amd64.whl");
    download::fetch(
        ORT_URL,
        &ort,
        ORT_SHA,
        0,
        base + span * 0.48,
        span * 0.32,
        ctx,
        "onnxruntime",
    )?;
    ctx.progress(Some(base + span * 0.82), "安装 onnxruntime");
    download::extract_zip(&ort, &site_packages())?;

    fs::write(
        runtime.join("python310._pth"),
        "python310.zip\n.\nLib\\site-packages\nimport site\n",
    )
    .map_err(|error| format!("写入 Python 路径失败：{error}"))?;
    ctx.progress(Some(base + span), "Python 运行时已就绪");
    Ok(())
}
