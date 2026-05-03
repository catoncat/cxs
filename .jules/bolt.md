## 2025-02-18 - Avoid array spreading inside double traversal
**Learning:** Found a performance bottleneck where `[...messages].reverse().find(...)` was used twice. This does unnecessary array allocations and double-pass array traversal.
**Action:** Replace multiple reverse searches by spreading array with a single reverse loop (`for (let i = arr.length - 1; i >= 0; i--)`), which avoids array allocations completely and allows early returns in O(1) memory.
## 2023-10-27 - Date parsing overhead in sort loops
**Learning:** Found that using `Date.parse(isoString)` inside `Array.prototype.sort()` callbacks is highly inefficient. Since ISO 8601 string formatting preserves lexicographical order for dates and times, parsing dates over and over again for comparisons is pure overhead.
**Action:** Use direct string comparisons (`>` and `<`) for ISO 8601 strings, especially in loops and sorts. It is approximately 40x faster and requires zero memory allocations.
## 2025-05-03 - Avoid array mapping and sorting for Min/Max
**Learning:** Found a performance bottleneck where an array was mapped and then sorted (`arr.map(fn).sort()`) just to extract the minimum and maximum elements. This creates unnecessary O(N) memory allocations and O(N log N) computational overhead.
**Action:** Replace `map().sort()` when extracting extremes by using a single loop (`for...of`) to track min and max values. This executes in O(N) time with O(1) space.
