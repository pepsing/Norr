import CoreGraphics

/// Positions in the web view's viewport, expressed as percentages of the split axis.
struct WindowDivision: Equatable {
  enum Axis: String { case vertical, horizontal }
  let axis: Axis
  let start: CGFloat
  let end: CGFloat

  init?(region: CGRect, in bounds: CGRect) {
    let frame = bounds.intersection(region)
    guard !frame.isNull, bounds.width > 0, bounds.height > 0 else { return nil }
    axis = frame.height > frame.width ? .vertical : .horizontal
    let vertical = axis == .vertical
    let origin = vertical ? bounds.minX : bounds.minY
    let length = vertical ? bounds.width : bounds.height
    start = ((vertical ? frame.minX : frame.minY) - origin) * 100 / length
    end = ((vertical ? frame.maxX : frame.maxY) - origin) * 100 / length
    guard start > 0, end < 100 else { return nil }
  }
}
