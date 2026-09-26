//! 静态数据：转换算子清单、音频导出格式、拼音表状态
//!
//! 这三样都是「描述性数据」，内容必须和 Node 版逐字段一致 —— 前端按 id 取值。

use std::path::Path;

use serde_json::{json, Value};

/// 转换前可选的加工算子。
/// 顺序和 Node 版一致（界面上按此顺序渲染）。
/// 注意：不能用 const —— `json!` 要跑 serde 的序列化，不是 const fn。
fn ops_table() -> Vec<(&'static str, &'static str, &'static str, Option<&'static str>, Value, &'static str)> {
    vec![
        // (id, 标签, 控件类型, 单位, 默认值, 说明)
        ("transpose", "转调", "number", Some("半音"), json!(0), "正数升调，负数降调，音高曲线同步移动"),
        ("lyrics", "歌词改写", "select", None, json!("none"), ""),
        ("quantize", "节奏量化", "select", None, json!("none"), ""),
        ("retargetBpm", "速度重设", "number", Some("BPM"), json!(0), "0 表示不改；填写后所有音符时间会等比缩放以保持绝对时长"),
        ("shiftBeats", "整体平移", "number", Some("拍"), json!(0), "常用 +1 拍留出前奏空位"),
        ("fitRange", "音域适配", "toggle", None, json!(false), "超出范围时整体平移八度而不是删音符"),
        ("clampRange", "限制音高到", "rangeKeys", None, json!(null), "把超范围音符吸附到边界（例如目标声库音域窄）"),
        ("removeShort", "清理过短音符", "number", Some("tick"), json!(0), "建议 30；0 表示不清"),
        ("mergeTied", "合并连续同音", "toggle", None, json!(false), ""),
        ("mergeTracks", "合并全部轨道", "toggle", None, json!(false), "目标格式单轨时使用"),
        ("splitByPitch", "按音高拆轨", "toggle", None, json!(false), ""),
        ("stripParams", "丢弃参数曲线", "toggle", None, json!(false), "目标格式不支持参数时避免产生垃圾数据"),
        ("resampleParams", "参数曲线重采样", "number", Some("tick"), json!(0), "目标格式要求等距采样时使用，建议 20"),
    ]
}

/// 歌词改写与量化两个算子的选项表
const LYRICS_OPTIONS: &[(&str, &str)] = &[
    ("none", "不改写"),
    ("kana2romaji", "假名 → 罗马音"),
    ("romaji2kana", "罗马音 → 假名"),
    ("katakana2hiragana", "片假名 → 平假名"),
    ("hiragana2katakana", "平假名 → 片假名"),
    ("zh2pinyin", "中文 → 拼音（需拼音表）"),
    ("vcv", "VCV 化（UTAU 连续音）"),
    ("cv", "CV 化（去掉 VCV 前缀）"),
];

const QUANTIZE_OPTIONS: &[(&str, &str)] = &[
    ("none", "不量化"),
    ("1/4", "四分音符"),
    ("1/8", "八分音符"),
    ("1/16", "十六分音符"),
    ("1/32", "三十二分音符"),
];

/// 组装成前端要的 JSON 数组
pub fn transform_ops() -> Value {
    let items: Vec<Value> = ops_table()
        .into_iter()
        .map(|(id, label, ty, unit, default, hint)| {
            let mut m = serde_json::Map::new();
            m.insert("id".into(), json!(id));
            m.insert("label".into(), json!(label));
            m.insert("type".into(), json!(ty));
            if let Some(u) = unit {
                m.insert("unit".into(), json!(u));
            }
            m.insert("default".into(), default.clone());

            let options = match id {
                "lyrics" => Some(LYRICS_OPTIONS),
                "quantize" => Some(QUANTIZE_OPTIONS),
                _ => None,
            };
            if let Some(opts) = options {
                m.insert(
                    "options".into(),
                    Value::Array(
                        opts.iter()
                            .map(|(v, l)| json!({ "value": v, "label": l }))
                            .collect(),
                    ),
                );
            }
            if !hint.is_empty() {
                m.insert("hint".into(), json!(hint));
            }
            Value::Object(m)
        })
        .collect();
    Value::Array(items)
}

/// 音频导出格式（ffmpeg 参数）
pub fn audio_formats() -> Value {
    json!({
        "wav":    { "label": "WAV 无损（推荐用于继续编辑）", "ext": ".wav",  "args": ["-c:a", "pcm_s16le"], "lossless": true },
        "wav24":  { "label": "WAV 24bit 无损",              "ext": ".wav",  "args": ["-c:a", "pcm_s24le"], "lossless": true },
        "flac":   { "label": "FLAC 无损压缩",               "ext": ".flac", "args": ["-c:a", "flac"],      "lossless": true },
        "mp3":    { "label": "MP3（320kbps）",              "ext": ".mp3",  "args": ["-c:a", "libmp3lame", "-b:a", "320k"], "lossless": false },
        "m4a":    { "label": "M4A / AAC（256kbps）",        "ext": ".m4a",  "args": ["-c:a", "aac", "-b:a", "256k"], "lossless": false },
        "ogg":    { "label": "OGG Vorbis（192kbps）",       "ext": ".ogg",  "args": ["-c:a", "libvorbis", "-b:a", "192k"], "lossless": false },
        "opus":   { "label": "Opus（192kbps，体积小）",     "ext": ".opus", "args": ["-c:a", "libopus", "-b:a", "192k"], "lossless": false },
    })
}

/// 拼音表状态。
///
/// 故意不在这里解析那份 315 KB 的 JSON —— 只在真正用到（歌词转拼音）时才读。
/// 所以 `chars` 在解析前是 0，`cached` 表示有没有缓存过。前端只是显示状态，不影响功能。
pub fn pinyin_summary(root: &Path) -> Value {
    let path = root.join("app").join("data").join("pinyin.json");
    match std::fs::metadata(&path) {
        Ok(md) => json!({
            "loaded": true,
            "cached": false,
            "chars": 0,
            "bytes": md.len(),
            "error": null,
        }),
        Err(e) => json!({
            "loaded": false,
            "cached": false,
            "chars": 0,
            "bytes": 0,
            "error": e.to_string(),
        }),
    }
}
