import CoreGraphics

@main
struct WindowDivisionTests {
  static func main() {
    let bounds = CGRect(x: 10, y: 20, width: 800, height: 600)
    let book = CGRect(x: 330, y: 0, width: 16, height: 850)
    let laptop = CGRect(x: 0, y: 290, width: 1000, height: 30)
    let x = WindowDivision(region: book, in: bounds)
    precondition(x?.axis == .vertical && x?.start == 40 && x?.end == 42)
    let y = WindowDivision(region: laptop, in: bounds)
    precondition(y?.axis == .horizontal && y?.start == 45 && y?.end == 50)
    precondition(WindowDivision(region: .null, in: bounds) == nil)
    precondition(WindowDivision(region: book, in: .zero) == nil)
    precondition(WindowDivision(region: book, in: CGRect(x: 342, y: 20, width: 380, height: 600)) == nil)
    precondition(WindowDivision(region: book, in: CGRect(x: 350, y: 20, width: 380, height: 600)) == nil)
  }
}
