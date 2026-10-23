// tabwright-fm: a small CLI around Apple's Foundation Models framework (SPEC 10.4).
// Protocol: one JSON object per line on stdin ({ "id", "op", ... }), one JSON reply per line on stdout
// ({ "id", "result" } or { "id", "error" }). Every prompt is kept small: the on-device context is ~4k tokens.
import Foundation
import FoundationModels

// MARK: - Guided generation types

@Generable
enum StepKind {
    case fillForm
    case skipFields
    case uploadResume
    case scrollTo
    case stop
}

@Generable
struct PlanStep {
    @Guide(description: "The kind of step")
    var kind: StepKind
    @Guide(description: "For skipFields only: the field labels or topics the user wants to fill in themselves. Empty otherwise.")
    var labels: [String]
    @Guide(description: "For scrollTo only: the visible text to scroll to. Empty otherwise.")
    var text: String
}

@Generable
struct Plan {
    @Guide(description: "True only if the instruction can be done on the current page using just these steps: fillForm, skipFields, uploadResume, scrollTo, stop.")
    var supported: Bool
    @Guide(description: "If not supported, a short reason such as 'needs navigation' or 'needs searching'. Empty if supported.")
    var unsupportedReason: String
    @Guide(description: "The steps, in order", .maximumCount(8))
    var steps: [PlanStep]
}

@Generable
struct FieldAnswer {
    @Guide(description: "Profile key that answers this field, or nil")
    var profileKey: String?
    @Guide(description: "Exact option text to choose, if the field has options")
    var option: String?
    @Guide(description: "True if the profile doesn't answer this")
    var askUser: Bool
}

// MARK: - IO

func reply(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

func availability() -> [String: Any] {
    let model = SystemLanguageModel.default
    switch model.availability {
    case .available:
        return ["available": true, "contextSize": model.contextSize]
    case .unavailable(let reason):
        let text: String
        switch reason {
        case .deviceNotEligible: text = "this Mac doesn't support Apple Intelligence"
        case .appleIntelligenceNotEnabled: text = "Apple Intelligence is turned off in System Settings"
        case .modelNotReady: text = "the on-device model is still downloading"
        @unknown default: text = "the on-device model isn't available"
        }
        return ["available": false, "reason": text]
    }
}

// MARK: - Operations

func plan(_ instruction: String) async throws -> [String: Any] {
    let session = LanguageModelSession(instructions: """
        You turn a user's instruction about the job application form on the current page into a plan. \
        The only possible steps are: fillForm (fill the form from the user's saved profile), \
        skipFields (fields the user wants to fill in themselves; copy their words as labels), \
        uploadResume, scrollTo (some visible text the user named), and stop. \
        Anything else is NOT supported: going to other pages or sites, searching for jobs, \
        applying to more than this one form, clicking submit, writing emails.

        Example: "Fill this out. Leave salary and visa questions for me." -> supported; \
        steps: fillForm, skipFields(labels: ["salary", "visa"]), uploadResume.
        Example: "Just upload my resume" -> supported; steps: uploadResume.
        Example: "Find backend jobs in Denver and apply" -> not supported, reason "needs searching and navigation".
        """)
    let response = try await session.respond(to: "Instruction: \(instruction)", generating: Plan.self)
    let p = response.content
    let steps: [[String: Any]] = p.steps.compactMap { s in
        var out: [String: Any] = ["kind": String(describing: s.kind)]
        if s.kind == .skipFields {
            let labels = s.labels.filter { !$0.isEmpty }
            if labels.isEmpty { return nil }
            out["labels"] = labels
        }
        if s.kind == .scrollTo {
            if s.text.isEmpty { return nil }
            out["text"] = s.text
        }
        return out
    }
    let reason = p.unsupportedReason.trimmingCharacters(in: .whitespacesAndNewlines)
    return ["steps": steps, "unsupportedReason": p.supported ? NSNull() : (reason.isEmpty ? "unsupported instruction" : reason)]
}

/// "answers.willingToRelocate" -> "willing to relocate"
func humanize(_ key: String) -> String {
    let last = key.split(separator: ".").last.map(String.init) ?? key
    var out = ""
    for ch in last {
        if ch.isUppercase { out += " " + ch.lowercased() } else if ch.isNumber, let l = out.last, !l.isNumber { out += " \(ch)" } else { out.append(ch) }
    }
    return out
}

/// Same shape as FieldAnswer, but built at runtime so profileKey and option can only be one of the
/// real keys/options (or "none"). Constrained decoding is far more reliable than a free String? here.
func fieldAnswerSchema(keys: [String], options: [String]) throws -> GenerationSchema {
    var props: [DynamicGenerationSchema.Property] = [
        .init(name: "profileKey", description: "Profile key that answers this field, or none",
              schema: DynamicGenerationSchema(name: "ProfileKey", anyOf: keys + ["none"])),
    ]
    if !options.isEmpty {
        props.append(.init(name: "option", description: "Exact option text to choose, or none",
                           schema: DynamicGenerationSchema(name: "Option", anyOf: Array(options.prefix(40)) + ["none"])))
    }
    props.append(.init(name: "askUser", description: "True if the profile doesn't answer this",
                       schema: DynamicGenerationSchema(type: Bool.self)))
    return try GenerationSchema(root: DynamicGenerationSchema(name: "FieldAnswer", properties: props), dependencies: [])
}

func match(label: String, kind: String, options: [String], keys: [String]) async throws -> [String: Any] {
    let session = LanguageModelSession(instructions: """
        You match one job application form field to a key in the user's profile. \
        Choose the key whose meaning answers the field, even when worded differently \
        ("Given name" is firstName, "Surname" is lastName, "Mobile" is phone). \
        If no key answers it, choose none and set askUser to true. Never invent answers.
        """)
    var prompt = "Field label: \(label)\nField type: \(kind)\n"
    if !options.isEmpty { prompt += "Options: \(options.prefix(40).joined(separator: " | "))\n" }
    prompt += "Profile keys:\n" + keys.map { "- \($0) (\(humanize($0)))" }.joined(separator: "\n")
    let response = try await session.respond(to: prompt, schema: try fieldAnswerSchema(keys: keys, options: options))
    let c = response.content
    let rawKey = (try? c.value(String.self, forProperty: "profileKey")) ?? "none"
    let rawOption = options.isEmpty ? "none" : ((try? c.value(String.self, forProperty: "option")) ?? "none")
    let ask = (try? c.value(Bool.self, forProperty: "askUser")) ?? true
    var key: String? = keys.contains(rawKey) ? rawKey : nil
    if let k = key, !(try await verify(label: label, key: k)) { key = nil }
    let answer = FieldAnswer(profileKey: key,
                             option: options.contains(rawOption) ? rawOption : nil,
                             askUser: key == nil ? true : ask)
    return ["profileKey": answer.profileKey ?? NSNull(), "option": answer.option ?? NSNull(), "askUser": answer.askUser]
}

@Generable
struct Verdict {
    @Guide(description: "True only if the profile value would be a correct, direct answer to the field")
    var answers: Bool
}

/// Second opinion on a match: small models over-match, and a wrong fill is worse than a blank one.
func verify(label: String, key: String) async throws -> Bool {
    let session = LanguageModelSession(instructions: "You check whether a saved profile value answers a form field. Be strict.")
    let prompt = "Form field: \"\(label)\"\nProfile value: the user's \(humanize(key))\nWould the user's \(humanize(key)) be the answer to this field?"
    return try await session.respond(to: prompt, generating: Verdict.self).content.answers
}

func draft(question: String, profileSummary: String) async throws -> [String: Any] {
    let session = LanguageModelSession(instructions: """
        You draft a short, plain, specific answer (2 to 4 sentences) to a job application question \
        for the applicant to review and edit. Don't invent facts beyond the summary given.
        """)
    let response = try await session.respond(to: "Applicant: \(profileSummary)\nQuestion: \(question)")
    return ["text": response.content]
}

// MARK: - Main loop

@main
struct Main {
    static func main() async {
        while let line = readLine(strippingNewline: true) {
            guard !line.isEmpty,
                  let data = line.data(using: .utf8),
                  let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            let id = msg["id"] ?? NSNull()
            let op = msg["op"] as? String ?? ""
            do {
                let result: [String: Any]
                switch op {
                case "availability":
                    result = availability()
                case "plan":
                    result = try await plan(msg["instruction"] as? String ?? "")
                case "match":
                    result = try await match(
                        label: msg["label"] as? String ?? "",
                        kind: msg["kind"] as? String ?? "text",
                        options: msg["options"] as? [String] ?? [],
                        keys: msg["profileKeys"] as? [String] ?? [])
                case "draft":
                    result = try await draft(
                        question: msg["question"] as? String ?? "",
                        profileSummary: msg["profileSummary"] as? String ?? "")
                default:
                    reply(["id": id, "error": "unknown op \(op)"])
                    continue
                }
                reply(["id": id, "result": result])
            } catch {
                reply(["id": id, "error": String(describing: error)])
            }
        }
    }
}
