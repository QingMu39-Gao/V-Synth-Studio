//! 资源库数据。只读 `data/resources.json`，不联网、不缓存。

use std::fs;

use serde::Deserialize;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resources {
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub notice: String,
    #[serde(default)]
    pub groups: Vec<Group>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Group {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub items: Vec<Item>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub home: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub region: String,
    #[serde(default)]
    pub cost: String,
    #[serde(default)]
    pub official: bool,
    #[serde(default)]
    pub desc: String,
    #[serde(default)]
    pub tip: String,
    #[serde(default)]
    pub verified: Option<Verified>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Verified {
    #[serde(default)]
    pub status: Option<i32>,
    #[serde(default)]
    pub checked_at: String,
    #[serde(default)]
    pub verdict: String,
}

impl Resources {
    pub fn load() -> Result<Self, String> {
        let path = crate::config::app_root()
            .join("data")
            .join("resources.json");
        let text = fs::read_to_string(&path)
            .map_err(|error| format!("读取资源库失败（{}）：{error}", path.display()))?;
        serde_json::from_str(&text)
            .map_err(|error| format!("解析资源库失败（{}）：{error}", path.display()))
    }

    pub fn item_count(&self) -> usize {
        self.groups.iter().map(|group| group.items.len()).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_minimal_document_and_defaults_missing_fields() {
        let resources: Resources = serde_json::from_str(
            r#"{
                "updatedAt": "2026-10-26",
                "notice": "notice",
                "groups": [{ "id": "g", "name": "G", "items": [{ "id": "i", "name": "I", "url": "https://example.com" }] }]
            }"#,
        )
        .unwrap();

        assert_eq!(resources.updated_at, "2026-10-26");
        assert_eq!(resources.item_count(), 1);
        assert_eq!(resources.groups[0].items[0].url, "https://example.com");
        assert!(!resources.groups[0].items[0].official);
    }
}
