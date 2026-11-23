import Foundation
import Security

let args = CommandLine.arguments
guard args.count == 3,
      ["read", "write"].contains(args[1]),
      ["polestar-china-session", "device-id", "polestar-geely-session"].contains(args[2]),
      args[1] != "write" || args[2] == "polestar-geely-session" else {
    exit(64)
}

let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "app.norr.mac.polestar4",
    kSecAttrAccount as String: args[2],
]
var status: OSStatus
if args[1] == "read" {
    var lookup = query
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    status = SecItemCopyMatching(lookup as CFDictionary, &result)
    if status == errSecSuccess, let data = result as? Data {
        FileHandle.standardOutput.write(data)
    }
} else {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard !data.isEmpty,
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let grant = object["grant"] as? [String: Any],
          let token = grant["accessToken"] as? String, !token.isEmpty,
          let refresh = grant["refreshToken"] as? String, !refresh.isEmpty else {
        exit(65)
    }
    status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
        var insert = query
        insert[kSecValueData as String] = data
        insert[kSecAttrLabel as String] = "Norr P4 Geely API verification"
        status = SecItemAdd(insert as CFDictionary, nil)
    }
}
if status != errSecSuccess {
    FileHandle.standardError.write(Data("Keychain status: \(status)\n".utf8))
    exit(status == errSecItemNotFound ? 44 : 1)
}
