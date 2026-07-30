//! Pure conversion from a decoded OTLP `ExportTraceServiceRequest` into
//! ClickHouse rows. This is deliberately side-effect free so it can be unit
//! tested without a database (see the tests at the bottom of this file); the
//! storage layer only deals with the [`Converted`] output.

use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{AnyValue, KeyValue, any_value::Value};
use opentelemetry_proto::tonic::trace::v1::{Status, span::SpanKind, status::StatusCode};
use time::OffsetDateTime;

use crate::model::{Converted, SpanEventRow, SpanRow};

/// Convert one OTLP export request into spans + span events.
pub fn convert(req: ExportTraceServiceRequest) -> Converted {
    let mut out = Converted::default();

    for resource_spans in req.resource_spans {
        let resource_attrs = resource_spans
            .resource
            .as_ref()
            .map(|r| r.attributes.as_slice())
            .unwrap_or_default();
        let service_name = attr_string(resource_attrs, "service.name").unwrap_or_default();
        let resource_attributes_json = attrs_to_json(resource_attrs);

        for scope_spans in resource_spans.scope_spans {
            let scope_name = scope_spans
                .scope
                .as_ref()
                .map(|s| s.name.clone())
                .unwrap_or_default();

            for span in scope_spans.spans {
                let attrs = span.attributes.as_slice();
                let trace_id = hex::encode(&span.trace_id);
                let span_id = hex::encode(&span.span_id);

                let input_tokens = attr_u32(attrs, "gen_ai.usage.input_tokens").unwrap_or(0);
                let output_tokens = attr_u32(attrs, "gen_ai.usage.output_tokens").unwrap_or(0);
                let total_tokens = attr_u32(attrs, "gen_ai.usage.total_tokens")
                    .unwrap_or_else(|| input_tokens.saturating_add(output_tokens));
                let (status_code, status_message) = status_parts(span.status.as_ref());

                // Span events carry content (gen_ai.*.message, exceptions, ...).
                for (index, event) in span.events.iter().enumerate() {
                    out.events.push(SpanEventRow {
                        trace_id: trace_id.clone(),
                        span_id: span_id.clone(),
                        event_index: index as u32,
                        name: event.name.clone(),
                        timestamp: ts_from_nanos(event.time_unix_nano),
                        body: attrs_to_json(&event.attributes),
                        attributes_json: "{}".to_owned(),
                    });
                }

                out.spans.push(SpanRow {
                    trace_id,
                    span_id,
                    parent_span_id: hex::encode(&span.parent_span_id),
                    name: span.name.clone(),
                    kind: kind_str(span.kind).to_owned(),
                    start_time: ts_from_nanos(span.start_time_unix_nano),
                    end_time: ts_from_nanos(span.end_time_unix_nano),
                    duration_ns: span
                        .end_time_unix_nano
                        .saturating_sub(span.start_time_unix_nano),
                    status_code,
                    status_message,
                    service_name: service_name.clone(),
                    scope_name: scope_name.clone(),
                    operation_name: attr_string(attrs, "gen_ai.operation.name").unwrap_or_default(),
                    provider: attr_string(attrs, "gen_ai.provider.name")
                        .or_else(|| attr_string(attrs, "gen_ai.system"))
                        .unwrap_or_default(),
                    request_model: attr_string(attrs, "gen_ai.request.model").unwrap_or_default(),
                    response_model: attr_string(attrs, "gen_ai.response.model").unwrap_or_default(),
                    input_tokens,
                    output_tokens,
                    total_tokens,
                    cost_usd: attr_f64(attrs, "tracebloom.cost.total_usd").unwrap_or(0.0),
                    response_id: attr_string(attrs, "gen_ai.response.id").unwrap_or_default(),
                    finish_reasons: attr_string_array(attrs, "gen_ai.response.finish_reasons"),
                    attributes_json: attrs_to_json(attrs),
                    resource_attributes_json: resource_attributes_json.clone(),
                });
            }
        }
    }

    out
}

fn find<'a>(attrs: &'a [KeyValue], key: &str) -> Option<&'a Value> {
    attrs
        .iter()
        .find(|kv| kv.key == key)
        .and_then(|kv| kv.value.as_ref())
        .and_then(|v| v.value.as_ref())
}

fn attr_string(attrs: &[KeyValue], key: &str) -> Option<String> {
    match find(attrs, key)? {
        Value::StringValue(s) => Some(s.clone()),
        _ => None,
    }
}

fn attr_u32(attrs: &[KeyValue], key: &str) -> Option<u32> {
    match find(attrs, key)? {
        Value::IntValue(i) => u32::try_from(*i).ok(),
        _ => None,
    }
}

fn attr_f64(attrs: &[KeyValue], key: &str) -> Option<f64> {
    match find(attrs, key)? {
        Value::DoubleValue(d) => Some(*d),
        Value::IntValue(i) => Some(*i as f64),
        _ => None,
    }
}

fn attr_string_array(attrs: &[KeyValue], key: &str) -> Vec<String> {
    match find(attrs, key) {
        Some(Value::ArrayValue(arr)) => arr
            .values
            .iter()
            .filter_map(|v| match v.value.as_ref() {
                Some(Value::StringValue(s)) => Some(s.clone()),
                _ => None,
            })
            .collect(),
        Some(Value::StringValue(s)) => vec![s.clone()],
        _ => Vec::new(),
    }
}

fn anyvalue_to_json(v: &AnyValue) -> serde_json::Value {
    use serde_json::Value as J;
    match v.value.as_ref() {
        None => J::Null,
        Some(Value::StringValue(s)) => J::String(s.clone()),
        Some(Value::BoolValue(b)) => J::Bool(*b),
        Some(Value::IntValue(i)) => J::Number((*i).into()),
        Some(Value::DoubleValue(d)) => serde_json::Number::from_f64(*d).map_or(J::Null, J::Number),
        Some(Value::BytesValue(b)) => J::String(hex::encode(b)),
        Some(Value::ArrayValue(a)) => J::Array(a.values.iter().map(anyvalue_to_json).collect()),
        Some(Value::KvlistValue(kv)) => J::Object(
            kv.values
                .iter()
                .map(|k| {
                    (
                        k.key.clone(),
                        k.value.as_ref().map_or(J::Null, anyvalue_to_json),
                    )
                })
                .collect(),
        ),
        // Newer OTLP variants (e.g. interned string-table references) aren't
        // resolvable here without the surrounding request context; record null
        // rather than drop the whole conversion.
        Some(_) => J::Null,
    }
}

fn attrs_to_json(attrs: &[KeyValue]) -> String {
    let map: serde_json::Map<String, serde_json::Value> = attrs
        .iter()
        .map(|kv| {
            (
                kv.key.clone(),
                kv.value
                    .as_ref()
                    .map_or(serde_json::Value::Null, anyvalue_to_json),
            )
        })
        .collect();
    serde_json::Value::Object(map).to_string()
}

fn ts_from_nanos(nanos: u64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(nanos))
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

fn kind_str(kind: i32) -> &'static str {
    match SpanKind::try_from(kind).unwrap_or(SpanKind::Unspecified) {
        SpanKind::Internal => "INTERNAL",
        SpanKind::Server => "SERVER",
        SpanKind::Client => "CLIENT",
        SpanKind::Producer => "PRODUCER",
        SpanKind::Consumer => "CONSUMER",
        SpanKind::Unspecified => "UNSPECIFIED",
    }
}

fn status_parts(status: Option<&Status>) -> (String, String) {
    match status {
        Some(s) => {
            let code = match StatusCode::try_from(s.code).unwrap_or(StatusCode::Unset) {
                StatusCode::Unset => "UNSET",
                StatusCode::Ok => "OK",
                StatusCode::Error => "ERROR",
            };
            (code.to_owned(), s.message.clone())
        }
        None => ("UNSET".to_owned(), String::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry_proto::tonic::common::v1::{
        AnyValue, ArrayValue, InstrumentationScope, KeyValue,
    };
    use opentelemetry_proto::tonic::resource::v1::Resource;
    use opentelemetry_proto::tonic::trace::v1::{
        ResourceSpans, ScopeSpans, Span, Status, span::Event,
    };

    fn kv(key: &str, value: Value) -> KeyValue {
        KeyValue {
            key: key.to_owned(),
            value: Some(AnyValue { value: Some(value) }),
            ..Default::default()
        }
    }

    fn sample_request() -> ExportTraceServiceRequest {
        let span = Span {
            trace_id: vec![0x11; 16],
            span_id: vec![0x22; 8],
            parent_span_id: vec![0x33; 8],
            name: "chat gpt-4o".to_owned(),
            kind: SpanKind::Client as i32,
            start_time_unix_nano: 1_000_000_000,
            end_time_unix_nano: 1_002_500_000, // +2.5ms
            status: Some(Status {
                code: StatusCode::Ok as i32,
                message: String::new(),
            }),
            attributes: vec![
                kv("gen_ai.operation.name", Value::StringValue("chat".into())),
                kv("gen_ai.provider.name", Value::StringValue("openai".into())),
                kv("gen_ai.request.model", Value::StringValue("gpt-4o".into())),
                kv(
                    "gen_ai.response.model",
                    Value::StringValue("gpt-4o-2024-08-06".into()),
                ),
                kv("gen_ai.usage.input_tokens", Value::IntValue(42)),
                kv("gen_ai.usage.output_tokens", Value::IntValue(58)),
                kv("tracebloom.cost.total_usd", Value::DoubleValue(0.00123)),
                kv(
                    "gen_ai.response.id",
                    Value::StringValue("chatcmpl-abc".into()),
                ),
                kv(
                    "gen_ai.response.finish_reasons",
                    Value::ArrayValue(ArrayValue {
                        values: vec![AnyValue {
                            value: Some(Value::StringValue("stop".into())),
                        }],
                    }),
                ),
            ],
            events: vec![Event {
                time_unix_nano: 1_001_000_000,
                name: "gen_ai.user.message".to_owned(),
                attributes: vec![kv("content", Value::StringValue("hello".into()))],
                ..Default::default()
            }],
            ..Default::default()
        };

        ExportTraceServiceRequest {
            resource_spans: vec![ResourceSpans {
                resource: Some(Resource {
                    attributes: vec![kv("service.name", Value::StringValue("demo".into()))],
                    ..Default::default()
                }),
                scope_spans: vec![ScopeSpans {
                    scope: Some(InstrumentationScope {
                        name: "tracebloom-sdk".to_owned(),
                        ..Default::default()
                    }),
                    spans: vec![span],
                    ..Default::default()
                }],
                ..Default::default()
            }],
        }
    }

    #[test]
    fn maps_gen_ai_span_to_typed_row() {
        let converted = convert(sample_request());
        assert_eq!(converted.spans.len(), 1);
        let s = &converted.spans[0];

        assert_eq!(s.trace_id, "11111111111111111111111111111111");
        assert_eq!(s.span_id, "2222222222222222");
        assert_eq!(s.parent_span_id, "3333333333333333");
        assert_eq!(s.kind, "CLIENT");
        assert_eq!(s.status_code, "OK");
        assert_eq!(s.operation_name, "chat");
        assert_eq!(s.provider, "openai");
        assert_eq!(s.request_model, "gpt-4o");
        assert_eq!(s.response_model, "gpt-4o-2024-08-06");
        assert_eq!(s.input_tokens, 42);
        assert_eq!(s.output_tokens, 58);
        assert_eq!(s.total_tokens, 100);
        assert!((s.cost_usd - 0.00123).abs() < 1e-9);
        assert_eq!(s.response_id, "chatcmpl-abc");
        assert_eq!(s.finish_reasons, vec!["stop".to_owned()]);
        assert_eq!(s.duration_ns, 2_500_000);
        assert_eq!(s.service_name, "demo");
        assert_eq!(s.scope_name, "tracebloom-sdk");
    }

    #[test]
    fn falls_back_to_gen_ai_system_for_provider() {
        let mut req = sample_request();
        // Replace provider.name with the older gen_ai.system attribute.
        let attrs = &mut req.resource_spans[0].scope_spans[0].spans[0].attributes;
        attrs.retain(|kv| kv.key != "gen_ai.provider.name");
        attrs.push(kv("gen_ai.system", Value::StringValue("anthropic".into())));

        let converted = convert(req);
        assert_eq!(converted.spans[0].provider, "anthropic");
    }

    #[test]
    fn extracts_events_as_separate_rows() {
        let converted = convert(sample_request());
        assert_eq!(converted.events.len(), 1);
        let e = &converted.events[0];
        assert_eq!(e.trace_id, "11111111111111111111111111111111");
        assert_eq!(e.span_id, "2222222222222222");
        assert_eq!(e.event_index, 0);
        assert_eq!(e.name, "gen_ai.user.message");

        let body: serde_json::Value = serde_json::from_str(&e.body).unwrap();
        assert_eq!(body["content"], "hello");
    }

    #[test]
    fn missing_usage_defaults_to_zero() {
        let mut req = sample_request();
        req.resource_spans[0].scope_spans[0].spans[0]
            .attributes
            .retain(|kv| !kv.key.starts_with("gen_ai.usage"));

        let converted = convert(req);
        let s = &converted.spans[0];
        assert_eq!(s.input_tokens, 0);
        assert_eq!(s.output_tokens, 0);
        assert_eq!(s.total_tokens, 0);
    }

    #[test]
    fn empty_request_yields_no_rows() {
        let converted = convert(ExportTraceServiceRequest::default());
        assert!(converted.is_empty());
    }
}
