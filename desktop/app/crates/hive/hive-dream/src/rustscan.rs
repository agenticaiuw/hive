//! A small Rust source reader for the gate: each line with its strings' contents and comments
//! taken out, and the items (fn, struct, const, mod, impl ...) with the lines they span and
//! whether they are test code (`#[cfg(test)]` modules, `#[test]` functions).

use regex::Regex;
use std::sync::LazyLock;

#[derive(Clone, Debug)]
pub struct Item {
    pub kind: String,
    pub name: String,
    /// First and last line, 0-based, inclusive.
    pub start: usize,
    pub end: usize,
    pub test: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Scan {
    /// Each line as code only: string literals kept as `""`, char literals as `''`, comments gone.
    pub stripped: Vec<String>,
    pub items: Vec<Item>,
}

impl Scan {
    /// Whether line `i` (0-based) is inside test code.
    pub fn is_test(&self, i: usize) -> bool {
        self.items
            .iter()
            .any(|it| it.test && it.start <= i && i <= it.end)
    }

    /// The names of the items line `i` is inside, outermost first.
    pub fn items_at(&self, i: usize) -> Vec<&Item> {
        self.items
            .iter()
            .filter(|it| it.start <= i && i <= it.end)
            .collect()
    }
}

#[derive(Clone, Copy, PartialEq)]
enum State {
    Code,
    LineComment,
    Block(u32),
    Str,
    Raw(usize),
}

fn ident(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Code with strings emptied and comments removed, line by line (the line count is kept).
pub fn strip(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut lines = vec![String::new()];
    let mut state = State::Code;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if c == '\n' {
            lines.push(String::new());
            if state == State::LineComment {
                state = State::Code;
            }
            i += 1;
            continue;
        }
        let out = lines.last_mut().expect("a line");
        match state {
            State::Code => {
                let prev_ident = i > 0 && ident(chars[i - 1]);
                if c == '/' && next == Some('/') {
                    state = State::LineComment;
                    i += 2;
                    continue;
                }
                if c == '/' && next == Some('*') {
                    state = State::Block(1);
                    i += 2;
                    continue;
                }
                if c == '"' {
                    out.push('"');
                    state = State::Str;
                    i += 1;
                    continue;
                }
                // r"..", r#".."#, br".."
                if c == 'r' && !(prev_ident && !(i > 0 && chars[i - 1] == 'b')) {
                    let mut j = i + 1;
                    while chars.get(j) == Some(&'#') {
                        j += 1;
                    }
                    if chars.get(j) == Some(&'"') {
                        out.push('"');
                        state = State::Raw(j - i - 1);
                        i = j + 1;
                        continue;
                    }
                }
                if c == '\'' {
                    // A char literal ('a', '\n', '{') or a lifetime ('a).
                    if next == Some('\\') {
                        let mut j = i + 2;
                        while j < chars.len() && chars[j] != '\'' && chars[j] != '\n' {
                            j += 1;
                        }
                        out.push_str("''");
                        i = j + 1;
                        continue;
                    }
                    if chars.get(i + 2) == Some(&'\'') && next != Some('\n') {
                        out.push_str("''");
                        i += 3;
                        continue;
                    }
                }
                out.push(c);
                i += 1;
            }
            State::LineComment => i += 1,
            State::Block(depth) => {
                if c == '/' && next == Some('*') {
                    state = State::Block(depth + 1);
                    i += 2;
                } else if c == '*' && next == Some('/') {
                    state = if depth <= 1 {
                        State::Code
                    } else {
                        State::Block(depth - 1)
                    };
                    i += 2;
                } else {
                    i += 1;
                }
            }
            State::Str => {
                if c == '\\' {
                    // An escaped newline still ends the source line.
                    i += if next == Some('\n') { 1 } else { 2 };
                } else if c == '"' {
                    out.push('"');
                    state = State::Code;
                    i += 1;
                } else {
                    i += 1;
                }
            }
            State::Raw(hashes) => {
                if c == '"' && (1..=hashes).all(|k| chars.get(i + k) == Some(&'#')) {
                    out.push('"');
                    state = State::Code;
                    i += 1 + hashes;
                } else {
                    i += 1;
                }
            }
        }
    }
    lines
}

static ITEM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"^\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\s*\([^)]*\))?\s+)?(?:(?:async|unsafe|const|default|extern(?:\s+"")?)\s+)*(fn|struct|enum|const|static|mod|impl|trait|type|union|macro_rules!)(?:\s*<[^{;]*?>)?\s*([A-Za-z_][A-Za-z0-9_]*)?"#,
    )
    .expect("item")
});

static TEST_ATTR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"#\[\s*(?:cfg\s*\(\s*test\s*\)|(?:[a-z_]+::)*test\s*(?:\]|\())").expect("test attr")
});

/// The last line (0-based) of the item that starts on line `start`.
fn item_end(stripped: &[String], start: usize) -> usize {
    let mut braces = 0i32;
    let mut parens = 0i32;
    let mut opened = false;
    for (n, line) in stripped.iter().enumerate().skip(start) {
        for c in line.chars() {
            match c {
                '{' => {
                    braces += 1;
                    opened = true;
                }
                '}' => {
                    braces -= 1;
                    if opened && braces <= 0 {
                        return n;
                    }
                }
                '(' | '[' => parens += 1,
                ')' | ']' => parens -= 1,
                ';' if braces == 0 && parens <= 0 && !opened => return n,
                _ => {}
            }
        }
    }
    stripped.len().saturating_sub(1)
}

pub fn scan(text: &str) -> Scan {
    let stripped = strip(text);
    let mut items = Vec::new();
    for (i, line) in stripped.iter().enumerate() {
        let Some(c) = ITEM.captures(line) else {
            continue;
        };
        let kind = c[1].to_string();
        let name = if kind == "impl" {
            // impl Trait for Type / impl Type: the type's name.
            let rest = line[c.get(0).map_or(0, |m| m.start())..].to_string();
            rest.split(" for ")
                .last()
                .and_then(|s| {
                    s.split(|ch: char| !ident(ch))
                        .rfind(|w| !w.is_empty() && w != &"impl")
                        .map(str::to_string)
                })
                .unwrap_or_default()
        } else {
            c.get(2).map_or(String::new(), |m| m.as_str().to_string())
        };
        // Attributes right above it (blank lines are doc comments that were stripped).
        // The item starts at its first attribute.
        let mut test = false;
        let mut first = i;
        let mut j = i;
        while j > 0 {
            j -= 1;
            let above = stripped[j].trim();
            if above.is_empty() {
                continue;
            }
            if above.starts_with("#[") {
                if TEST_ATTR.is_match(above) {
                    test = true;
                }
                first = j;
                continue;
            }
            break;
        }
        // A one-line attribute in front of the item on the same line.
        if TEST_ATTR.is_match(line.split(&kind).next().unwrap_or("")) {
            test = true;
        }
        items.push(Item {
            end: item_end(&stripped, i),
            kind,
            name,
            start: first,
            test,
        });
    }
    Scan { stripped, items }
}
