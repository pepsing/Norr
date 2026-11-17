import Foundation

struct WatchWire {
    enum Value { case integer(UInt64), bytes(Data), number(Double) }
    let fields: [Int: Value]

    init(_ data: Data) throws {
        guard data.count <= 2_000_000 else { throw WatchFailure(message: "车辆响应过大") }
        let bytes = Array(data)
        var cursor = 0
        var values = [Int: Value]()
        func integer() throws -> UInt64 {
            var result: UInt64 = 0
            for shift in stride(from: 0, through: 63, by: 7) {
                guard cursor < bytes.count else { throw WatchFailure(message: "车辆响应不完整") }
                let byte = bytes[cursor]
                cursor += 1
                guard shift != 63 || byte < 2 else { throw WatchFailure(message: "车辆响应整数溢出") }
                result |= UInt64(byte & 127) << shift
                if byte < 128 { return result }
            }
            throw WatchFailure(message: "车辆响应整数无效")
        }
        while cursor < bytes.count {
            let key = try integer()
            let field = Int(key >> 3)
            guard field > 0 else { throw WatchFailure(message: "车辆字段无效") }
            if key & 7 == 0 {
                values[field] = .integer(try integer())
                continue
            }
            let size: Int
            switch key & 7 {
            case 1: size = 8
            case 5: size = 4
            case 2:
                let count = try integer()
                guard count <= 2_000_000 else { throw WatchFailure(message: "车辆字段过大") }
                size = Int(count)
            default: throw WatchFailure(message: "车辆响应类型不支持")
            }
            guard size <= bytes.count - cursor else { throw WatchFailure(message: "车辆响应不完整") }
            let part = Array(bytes[cursor..<(cursor + size)])
            cursor += size
            if key & 7 == 2 { values[field] = .bytes(Data(part)) }
            else {
                let bits = part.enumerated().reduce(UInt64(0)) { $0 | UInt64($1.element) << ($1.offset * 8) }
                values[field] = .number(size == 4 ? Double(Float(bitPattern: UInt32(bits))) : Double(bitPattern: bits))
            }
        }
        fields = values
    }

    func int(_ field: Int) -> UInt64? { if case .integer(let value) = fields[field] { return value }; return nil }
    func number(_ field: Int) -> Double? {
        let value: Double?
        switch fields[field] {
        case .integer(let n): value = Double(n)
        case .number(let n): value = n
        default: value = nil
        }
        return value.flatMap { $0.isFinite ? $0 : nil }
    }
    func bytes(_ field: Int) -> Data? { if case .bytes(let value) = fields[field] { return value }; return nil }
    func string(_ field: Int) -> String? { bytes(field).flatMap { String(data: $0, encoding: .utf8) } }
    func nested(_ field: Int) throws -> WatchWire? { try bytes(field).map(WatchWire.init) }
    func timestamp(_ field: Int) throws -> Date? {
        guard let time = try nested(field), let seconds = time.int(1) else { return nil }
        let nanos = time.int(2) ?? 0
        guard nanos < 1_000_000_000 else { return nil }
        return Date(timeIntervalSince1970: Double(seconds) + Double(nanos) / 1_000_000_000)
    }
    static func varint(_ value: UInt64) -> Data {
        var value = value
        var output = Data()
        while value >= 128 { output.append(UInt8(value & 127) | 128); value >>= 7 }
        output.append(UInt8(value))
        return output
    }
    static func integer(_ field: Int, _ value: UInt64) -> Data { varint(UInt64(field << 3)) + varint(value) }
    static func bytes(_ field: Int, _ value: Data) -> Data { varint(UInt64(field << 3 | 2)) + varint(UInt64(value.count)) + value }
    static func string(_ field: Int, _ value: String) -> Data { bytes(field, Data(value.utf8)) }
    static func float(_ field: Int, _ value: Float) -> Data {
        let bits = value.bitPattern
        return varint(UInt64(field << 3 | 5)) + Data((0..<4).map { UInt8(truncatingIfNeeded: bits >> ($0 * 8)) })
    }
}
