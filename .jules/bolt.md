## 2024-05-18 - Typescript `findLast` unavailability
**Learning:** Target environment (TS config / Node setup) for this codebase does not support array `.findLast()`. Trying to use it results in compilation errors.
**Action:** Use a backwards `for` loop to find the last occurrence of an item matching a predicate instead of relying on `findLast`.
