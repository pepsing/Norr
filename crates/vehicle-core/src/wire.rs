use crate::Result;

#[derive(Clone, Debug)]
pub enum Value {
    Integer(u64),
    Fixed64(u64),
    Bytes(Vec<u8>),
    Fixed32(u32),
}

#[derive(Clone, Debug)]
pub struct Message(pub Vec<(u32, Value)>);

fn varint(bytes: &[u8], cursor: &mut usize) -> Result<u64> {
    let mut result = 0u64;
    for shift in (0..70).step_by(7) {
        let byte = *bytes.get(*cursor).ok_or("车辆响应被截断")?;
        *cursor += 1;
        if shift == 63 && byte > 1 {
            return Err("车辆响应整数溢出".into());
        }
        result |= ((byte & 127) as u64) << shift;
        if byte < 128 {
            return Ok(result);
        }
    }
    Err("车辆响应整数无效".into())
}

impl Message {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > 2_000_000 {
            return Err("车辆响应过大".into());
        }
        let mut cursor = 0;
        let mut fields = Vec::new();
        while cursor < bytes.len() {
            let key = varint(bytes, &mut cursor)?;
            let number = u32::try_from(key >> 3).map_err(|_| "车辆字段编号无效")?;
            if number == 0 {
                return Err("车辆字段编号无效".into());
            }
            let value = match key & 7 {
                0 => Value::Integer(varint(bytes, &mut cursor)?),
                wire @ (1 | 2 | 5) => {
                    let size = match wire {
                        1 => 8,
                        5 => 4,
                        _ => usize::try_from(varint(bytes, &mut cursor)?)
                            .map_err(|_| "车辆字段过大")?,
                    };
                    let end = cursor.checked_add(size).ok_or("车辆响应长度溢出")?;
                    let data = bytes.get(cursor..end).ok_or("车辆响应被截断")?;
                    cursor = end;
                    match wire {
                        1 => Value::Fixed64(u64::from_le_bytes(data.try_into().unwrap())),
                        5 => Value::Fixed32(u32::from_le_bytes(data.try_into().unwrap())),
                        _ => Value::Bytes(data.to_vec()),
                    }
                }
                _ => return Err("车辆响应字段类型不支持".into()),
            };
            fields.push((number, value));
        }
        Ok(Self(fields))
    }

    pub fn value(&self, number: u32) -> Option<&Value> {
        self.0
            .iter()
            .rev()
            .find(|(key, _)| *key == number)
            .map(|(_, value)| value)
    }
    pub fn int(&self, number: u32) -> Option<u64> {
        match self.value(number)? {
            Value::Integer(value) => Some(*value),
            _ => None,
        }
    }
    pub fn number(&self, number: u32) -> Option<f64> {
        let value = match self.value(number)? {
            Value::Integer(value) => *value as f64,
            Value::Fixed64(value) => f64::from_bits(*value),
            Value::Fixed32(value) => f32::from_bits(*value) as f64,
            _ => return None,
        };
        value.is_finite().then_some(value)
    }
    pub fn bytes(&self, number: u32) -> Option<&[u8]> {
        match self.value(number)? {
            Value::Bytes(value) => Some(value),
            _ => None,
        }
    }
    pub fn string(&self, number: u32) -> Option<String> {
        std::str::from_utf8(self.bytes(number)?)
            .ok()
            .map(str::to_owned)
    }
    pub fn nested(&self, number: u32) -> Result<Option<Self>> {
        self.bytes(number).map(Self::parse).transpose()
    }
    pub fn messages(&self, number: u32) -> Result<Vec<Self>> {
        self.0
            .iter()
            .filter_map(|(key, value)| match value {
                Value::Bytes(bytes) if *key == number => Some(Self::parse(bytes)),
                _ => None,
            })
            .collect()
    }
    pub fn integers(&self, number: u32) -> Result<Vec<u64>> {
        let mut values = Vec::new();
        for (key, value) in &self.0 {
            if *key != number {
                continue;
            }
            match value {
                Value::Integer(value) => values.push(*value),
                Value::Bytes(bytes) => {
                    let mut cursor = 0;
                    while cursor < bytes.len() {
                        values.push(varint(bytes, &mut cursor)?);
                    }
                }
                _ => return Err("车辆列表字段无效".into()),
            }
        }
        Ok(values)
    }
    pub fn timestamp(&self, number: u32) -> Option<u64> {
        let time = self.nested(number).ok()??;
        let seconds = time.int(1)?;
        let nanos = time.int(2).unwrap_or(0);
        if nanos >= 1_000_000_000 {
            return None;
        }
        seconds.checked_mul(1000)?.checked_add(nanos / 1_000_000)
    }
}

fn encode_varint(mut number: u64) -> Vec<u8> {
    let mut bytes = Vec::new();
    while number >= 128 {
        bytes.push((number as u8 & 127) | 128);
        number >>= 7;
    }
    bytes.push(number as u8);
    bytes
}
pub fn integer(field: u32, value: u64) -> Vec<u8> {
    [encode_varint((field as u64) << 3), encode_varint(value)].concat()
}
pub fn packed(field: u32, values: &[u64]) -> Vec<u8> {
    bytes(
        field,
        &values
            .iter()
            .flat_map(|value| encode_varint(*value))
            .collect::<Vec<_>>(),
    )
}
pub fn bytes(field: u32, value: &[u8]) -> Vec<u8> {
    [
        encode_varint(((field as u64) << 3) | 2),
        encode_varint(value.len() as u64),
        value.to_vec(),
    ]
    .concat()
}
pub fn string(field: u32, value: &str) -> Vec<u8> {
    bytes(field, value.as_bytes())
}
pub fn float(field: u32, value: f32) -> Vec<u8> {
    [
        encode_varint(((field as u64) << 3) | 5),
        value.to_le_bytes().to_vec(),
    ]
    .concat()
}
pub fn state_request(vin: &str) -> Vec<u8> {
    [string(1, &uuid::Uuid::new_v4().to_string()), string(2, vin)].concat()
}
pub fn payload(body: &[u8], vin: &str) -> Result<Message> {
    let envelope = Message::parse(body)?;
    if let Some(actual) = envelope.string(2) {
        if !actual.eq_ignore_ascii_case(vin) {
            return Err("车辆响应身份不匹配".into());
        }
    }
    Message::parse(envelope.bytes(3).ok_or("车辆响应缺少数据")?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_truncation_and_wrong_vehicle() {
        assert!(Message::parse(&[10, 8, 1]).is_err());
        assert!(Message::parse(&[0]).is_err());
        let response = [string(2, "CAR-A"), bytes(3, &integer(1, 1))].concat();
        assert!(payload(&response, "CAR-B").is_err());
        assert_eq!(payload(&response, "CAR-A").unwrap().int(1), Some(1));
    }
    #[test]
    fn preserves_missing_and_explicit_zero() {
        let message = Message::parse(&integer(2, 0)).unwrap();
        assert_eq!(message.int(1), None);
        assert_eq!(message.int(2), Some(0));
    }
}
