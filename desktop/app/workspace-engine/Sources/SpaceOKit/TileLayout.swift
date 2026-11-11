import Foundation
import CoreGraphics

/// How a shared agent display is divided between sessions.
///
/// Creating a virtual display is not free — it is a whole framebuffer the WindowServer has to
/// composite — so several agents share one. Each gets a tile, and every tile is a real region
/// of a genuinely visible display, which is what preserves the property the whole design rests
/// on: windows there keep rendering.
///
/// Pure geometry, so the packing rules are testable without touching the WindowServer.
public enum TileLayout {

    /// The most tiles the convenience full-layout API will materialize.
    ///
    /// This is an allocation bound for `rects`, not a product limit on display density.
    /// Production allocation uses `rect(in:capacity:index:)`, which stays O(1).
    public static let maximumMaterializedCapacity = 64

    /// Column/row split for a given capacity. Wider than tall, because app windows are.
    public static func grid(for capacity: Int) -> (columns: Int, rows: Int) {
        let n = max(1, capacity)
        switch n {
        case 1:      return (1, 1)
        case 2:      return (2, 1)
        case 3, 4:   return (2, 2)
        case 5, 6:   return (3, 2)
        case 7...9:  return (3, 3)
        case 10...12: return (4, 3)
        default:
            let columns = Int(ceil(sqrt(Double(n))))
            let quotient = n / columns
            let rows = quotient + (n % columns == 0 ? 0 : 1)
            return (columns, rows)
        }
    }

    /// The tile rects for `capacity` sessions inside `bounds`, in row-major order.
    ///
    /// Tiles tile the display exactly — no gutters. A gutter would waste pixels an agent could
    /// be reading, and nothing here needs to look pretty to a human.
    ///
    /// Returns a *prefix* of the layout: the first `maximumMaterializedCapacity` tiles at most,
    /// so the array never scales with a caller-supplied integer. The grid itself always comes
    /// from the real `capacity`, which is what makes `rects(in:capacity:)[i]` identical to
    /// `rect(in:capacity:index: i)` for every index returned. Clamping the grid instead handed
    /// the two APIs different, overlapping rects for the same session above the bound — at
    /// capacity 100 an 8x8 layout of 240x135 tiles against a 10x10 layout of 192x108 — and
    /// overlapping tiles are how one agent's window ends up in another agent's screenshot.
    ///
    /// Per-tile lookup stays O(1) through `rect(in:capacity:index:)` — use that on any hot path,
    /// and for any index the prefix does not reach.
    public static func rects(in bounds: CGRect, capacity: Int) -> [CGRect] {
        guard capacity > 0 else { return [] }
        let (columns, rows) = grid(for: capacity)
        let tileWidth = (bounds.width / CGFloat(columns)).rounded(.down)
        let tileHeight = (bounds.height / CGFloat(rows)).rounded(.down)

        let n = min(maximumMaterializedCapacity, capacity)
        var out: [CGRect] = []
        out.reserveCapacity(n)
        for index in 0..<n {
            let column = index % columns
            let row = index / columns
            out.append(CGRect(x: bounds.minX + CGFloat(column) * tileWidth,
                              y: bounds.minY + CGFloat(row) * tileHeight,
                              width: tileWidth,
                              height: tileHeight))
        }
        return out
    }

    /// The tile at `index`, or nil when the index is outside the capacity.
    ///
    /// O(1) and allocation-free — the lookup every session's `frame` goes through.
    public static func rect(in bounds: CGRect, capacity: Int, index: Int) -> CGRect? {
        guard capacity > 0, index >= 0, index < capacity else { return nil }
        let (columns, rows) = grid(for: capacity)
        let tileWidth = (bounds.width / CGFloat(columns)).rounded(.down)
        let tileHeight = (bounds.height / CGFloat(rows)).rounded(.down)
        let column = index % columns
        let row = index / columns
        return CGRect(x: bounds.minX + CGFloat(column) * tileWidth,
                      y: bounds.minY + CGFloat(row) * tileHeight,
                      width: tileWidth,
                      height: tileHeight)
    }

    /// A display size that gives `capacity` sessions a comfortable tile each.
    ///
    /// Grow the framebuffer with density to preserve usable tile dimensions. Larger displays
    /// consume more WindowServer memory; allocation and geometry failures remain explicit.
    public static func displaySize(forCapacity capacity: Int,
                                   tile: CGSize = CGSize(width: 1280, height: 800)) -> CGSize {
        let (columns, rows) = grid(for: capacity)
        return CGSize(width: tile.width * CGFloat(columns),
                      height: tile.height * CGFloat(rows))
    }

}
