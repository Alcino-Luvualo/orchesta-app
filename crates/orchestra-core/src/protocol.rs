use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The wire protocol is deliberately versioned independently from the app
/// version. A renderer and a daemon must agree on this value before any
/// state-changing operation is accepted.
pub const PROTOCOL_VERSION: u32 = 2;
pub const MAX_FRAME_SIZE: usize = 8 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub struct Request {
    #[serde(rename = "protocolVersion", default)]
    pub protocol_version: u32,
    #[serde(rename = "requestId")]
    pub request_id: Option<String>,
    #[serde(rename = "type")]
    pub message_type: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Serialize)]
pub struct Response<'a> {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    #[serde(rename = "requestId")]
    pub request_id: &'a str,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Event {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    #[serde(rename = "eventId")]
    pub event_id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub payload: Value,
}

pub fn is_supported(version: u32) -> bool {
    version == PROTOCOL_VERSION
}

#[cfg(test)]
mod tests {
    use super::{is_supported, Request, PROTOCOL_VERSION};

    #[test]
    fn accepts_only_the_current_protocol_version() {
        assert!(is_supported(PROTOCOL_VERSION));
        assert!(!is_supported(PROTOCOL_VERSION + 1));
    }

    #[test]
    fn deserializes_camel_case_wire_fields() {
        let request: Request = serde_json::from_str(
            r#"{"protocolVersion":2,"requestId":"req_1","type":"system.hello","payload":{}}"#,
        )
        .expect("request should deserialize");
        assert_eq!(request.protocol_version, PROTOCOL_VERSION);
        assert_eq!(request.request_id.as_deref(), Some("req_1"));
        assert_eq!(request.message_type, "system.hello");
    }
}
