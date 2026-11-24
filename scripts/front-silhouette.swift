// Emit a grayscale mask in the coordinates of the source studio photograph.
import CoreImage
import Foundation
import Vision

let handler = VNImageRequestHandler(url: URL(fileURLWithPath: CommandLine.arguments[1]))
let request = VNGenerateForegroundInstanceMaskRequest()
try handler.perform([request])
guard let result = request.results?.first, !result.allInstances.isEmpty else {
    throw CocoaError(.fileReadCorruptFile)
}
let buffer = try result.generateScaledMaskForImage(forInstances: result.allInstances, from: handler)
try CIContext().writePNGRepresentation(of: CIImage(cvPixelBuffer: buffer),
    to: URL(fileURLWithPath: CommandLine.arguments[2]), format: .L8,
    colorSpace: CGColorSpaceCreateDeviceGray())
