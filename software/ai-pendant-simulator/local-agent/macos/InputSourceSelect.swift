import Carbon
import Foundation

func propString(_ src: TISInputSource, _ key: CFString) -> String {
  guard let cf = TISGetInputSourceProperty(src, key) else { return "" }
  return Unmanaged<CFString>.fromOpaque(cf).takeUnretainedValue() as String
}

func propBool(_ src: TISInputSource, _ key: CFString) -> Bool {
  guard let cf = TISGetInputSourceProperty(src, key) else { return false }
  return Unmanaged<CFBoolean>.fromOpaque(cf).takeUnretainedValue() == kCFBooleanTrue
}

func name(of src: TISInputSource) -> String { propString(src, kTISPropertyLocalizedName) }
func id(of src: TISInputSource) -> String { propString(src, kTISPropertyInputSourceID) }
func category(of src: TISInputSource) -> String { propString(src, kTISPropertyInputSourceCategory) }

let args = CommandLine.arguments
let mode = args.count > 1 ? args[1] : "list"
let query = args.count > 2 ? args[2].lowercased() : ""

func allSources(includeDisabled: Bool) -> [TISInputSource] {
  let list = TISCreateInputSourceList(nil, includeDisabled).takeRetainedValue() as! [TISInputSource]
  return list.filter { category(of: $0) == (kTISCategoryKeyboardInputSource as String) }
}

func score(_ src: TISInputSource, wanted: String) -> Int {
  let n = name(of: src).lowercased()
  let i = id(of: src).lowercased()
  if n == wanted || i == wanted { return 100 }
  if n.hasPrefix(wanted) || i.hasSuffix(wanted) { return 80 }
  if n.contains(wanted) || i.contains(wanted) { return 60 }

  let aliases: [String: [String]] = [
    "arabic": ["arabic", "ar", "العربية"],
    "korean": ["korean", "2-set", "hangul", "한글", "한국어", "2set"],
    "english": ["u.s.", "us", "abc", "english", "american", "영국", "영어"],
    "japanese": ["japanese", "hiragana", "日本語", "일본어"],
    "chinese": ["pinyin", "chinese", "中文", "중국어"],
    "spanish": ["spanish", "español", "스페인"],
    "french": ["french", "français", "프랑스"],
    "german": ["german", "deutsch", "독일"],
    "russian": ["russian", "русский", "러시아"],
  ]

  for (key, values) in aliases where wanted.contains(key) || key.contains(wanted) {
    if values.contains(where: { n.contains($0) || i.contains($0) }) {
      return 70
    }
  }
  return 0
}

if mode == "list" {
  for src in allSources(includeDisabled: false) {
    print("\(id(of: src))\t\(name(of: src))")
  }
  exit(0)
}

if mode == "current" {
  let src = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
  print("\(id(of: src))\t\(name(of: src))")
  exit(0)
}

if mode == "select" {
  let enabled = allSources(includeDisabled: false)
  let all = allSources(includeDisabled: true)

  func prefer(_ src: TISInputSource) -> Int {
    var bonus = 0
    let i = id(of: src).lowercased()
    // Prefer concrete layouts/modes over parent input-method bundles.
    if i.contains(".2set") || i.contains("keylayout.") { bonus += 15 }
    if propBool(src, kTISPropertyInputSourceIsSelectCapable) { bonus += 10 }
    if propBool(src, kTISPropertyInputSourceIsEnabled) { bonus += 20 }
    return bonus
  }

  let rankedEnabled = enabled
    .map { ($0, score($0, wanted: query) + prefer($0)) }
    .filter { score($0.0, wanted: query) > 0 }
    .sorted { $0.1 > $1.1 }
  let rankedAll = all
    .map { ($0, score($0, wanted: query) + prefer($0)) }
    .filter { score($0.0, wanted: query) > 0 }
    .sorted { $0.1 > $1.1 }

  var target: TISInputSource? = rankedEnabled.first?.0
  var enabledNow = false

  if target == nil, let candidate = rankedAll.first?.0 {
    let enableStatus = TISEnableInputSource(candidate)
    if enableStatus != noErr {
      fputs(
        "Found \(name(of: candidate)), but macOS blocked enabling it. Add it once in System Settings → Keyboard → Input Sources.\n",
        stderr,
      )
      exit(4)
    }
    usleep(350_000)
    target = candidate
    enabledNow = true
  }

  guard let match = target else {
    fputs(
      "No keyboard layout matched “\(query)”. Add it in System Settings → Keyboard → Input Sources, then retry.\n",
      stderr,
    )
    exit(2)
  }

  // If selecting a parent Korean IME fails, fall back to 2-Set Korean mode.
  var selected = match
  var status = TISSelectInputSource(selected)
  if status != noErr {
    let fallback = (rankedEnabled + rankedAll)
      .map(\.0)
      .first {
        id(of: $0).lowercased().contains("2set") &&
          score($0, wanted: query) > 0
      }
    if let fallback {
      selected = fallback
      status = TISSelectInputSource(selected)
    }
  }

  if status != noErr {
    fputs(
      "Could not switch to \(name(of: selected)) (status \(status)).\n",
      stderr,
    )
    exit(3)
  }

  let suffix = enabledNow ? "\tenabled" : ""
  print("\(id(of: selected))\t\(name(of: selected))\(suffix)")
  exit(0)
}

fputs("Usage: list|current|select <query>\n", stderr)
exit(1)
