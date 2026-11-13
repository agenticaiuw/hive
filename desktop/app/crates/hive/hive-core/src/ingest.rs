//! Split user-provided material without dropping or changing any characters.
pub fn split(text: &str, size: usize) -> Result<Vec<String>, &'static str> {
    if size == 0 {
        return Err("Chunk size must be positive");
    }
    let chars: Vec<char> = text.chars().collect();
    let mut parts = Vec::new();
    let mut start = 0;
    while chars.len() - start > size {
        let window = &chars[start..start + size];
        let mut cut = size;
        for pattern in [&['\n', '\n'][..], &['\n'][..], &['.', ' '][..], &[' '][..]] {
            if let Some(at) = (size / 2..=size.saturating_sub(pattern.len()))
                .rev()
                .find(|&at| {
                    at + pattern.len() <= size && &window[at..at + pattern.len()] == pattern
                })
            {
                cut = at + pattern.len();
                break;
            }
        }
        parts.push(window[..cut].iter().collect());
        start += cut;
    }
    if start < chars.len() || parts.is_empty() {
        parts.push(chars[start..].iter().collect());
    }
    Ok(parts)
}

/// Verify only a marker actually present on one rollout line.
pub fn in_rollout(path: &std::path::Path, marker: &str) -> std::io::Result<bool> {
    use std::io::BufRead;
    let mut reader = std::io::BufReader::new(std::fs::File::open(path)?);
    let mut line = Vec::new();
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line)? == 0 {
            return Ok(false);
        }
        if String::from_utf8_lossy(&line).contains(marker) {
            return Ok(true);
        }
    }
}
