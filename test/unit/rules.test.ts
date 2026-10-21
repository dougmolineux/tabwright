import { describe, expect, it } from "vitest";
import { isEeoField, labelMatchesAny, matchOption, matchRule, profileKeys, profileValue, skipPhrasesFromInstruction } from "../../host/src/rules.ts";
import { classifyClaudeFailure, unsupportedByRules } from "../../host/src/runner.ts";

const profile = {
  firstName: "Jane",
  lastName: "Doe",
  email: "jane@example.com",
  city: "Springfield",
  state: "IL",
  links: { github: "https://github.com/x", linkedin: null },
  answers: { yearsExperience: 17, workAuthorizedNoSponsorship: null },
};

const f = (label: string, kind = "text") => ({ ref: "e1", label, kind });

describe("rules engine", () => {
  it("maps common labels to profile keys", () => {
    expect(matchRule(f("First Name*"))).toBe("firstName");
    expect(matchRule(f("Given name"))).toBe("firstName");
    expect(matchRule(f("Last Name *"))).toBe("lastName");
    expect(matchRule(f("Preferred First Name"))).toBe("preferredName");
    expect(matchRule(f("Email*", "email"))).toBe("email");
    expect(matchRule(f("Phone"))).toBe("phone");
    expect(matchRule(f("LinkedIn Profile*"))).toBe("links.linkedin");
    expect(matchRule(f("Resume/CV*", "file"))).toBe("resumePath");
    expect(matchRule(f("Are you currently authorized to work in the United States?", "combobox"))).toBe("answers.workAuthorizedNoSponsorship");
    expect(matchRule(f("Full name"))).toBe("@fullName");
  });

  it("only matches exact patterns", () => {
    expect(matchRule(f("Why do you want to work here?", "textarea"))).toBeNull();
    expect(matchRule(f("Name of your first pet"))).toBeNull();
    expect(matchRule(f("Resume/CV", "text"))).toBeNull(); // resume rule is file-only
  });

  it("resolves values, including composites and null = ask", () => {
    expect(profileValue(profile, "@fullName").value).toBe("Jane Doe");
    expect(profileValue(profile, "@location").value).toBe("Springfield, IL");
    expect(profileValue(profile, "links.linkedin").value).toBeNull();
    expect(profileValue(profile, "answers.missing").value).toBeUndefined();
    expect(profileKeys(profile)).toContain("answers.yearsExperience");
    expect(profileKeys(profile)).not.toContain("links");
  });

  it("chooses options conservatively", () => {
    expect(matchOption("United States", ["Canada", "United States"])).toBe("United States");
    expect(matchOption("yes", ["Yes", "No"])).toBe("Yes");
    expect(matchOption("Yes", ["Yes, I am authorized", "No, I need sponsorship"])).toBe("Yes, I am authorized");
    expect(matchOption(17, ["0-5", "6-10", "10+ years"])).toBe("10+ years");
    expect(matchOption("Maybe", ["Yes", "No"])).toBeNull();
  });

  it("never fills EEO questions", () => {
    expect(isEeoField("Gender")).toBe(true);
    expect(isEeoField("Are you Hispanic/Latino?")).toBe(true);
    expect(isEeoField("Veteran Status")).toBe(true);
    expect(isEeoField("Disability Status")).toBe(true);
    expect(isEeoField("Race")).toBe(true);
    expect(isEeoField("Email")).toBe(false);
  });

  it("parses 'leave X for me' from instructions", () => {
    const skip = skipPhrasesFromInstruction("Fill out this application with my details. Leave work authorization and salary for me.");
    expect(skip).toEqual(["work authorization", "salary"]);
    expect(labelMatchesAny("Are you currently authorized to work in the United States?", ["work authorization"])).toBe(true);
    expect(labelMatchesAny("Desired salary", skip)).toBe(true);
    expect(labelMatchesAny("Email", skip)).toBe(false);
    // Used to reject skip labels the model invented: they must appear in the instruction.
    const instr = "Fill out this application with my details. Leave work authorization and salary for me.";
    expect(labelMatchesAny(instr, ["work authorization"])).toBe(true);
    expect(labelMatchesAny(instr, ["first name"])).toBe(false);
  });

  it("flags instructions on-device mode can't do", () => {
    expect(unsupportedByRules("Find me 5 backend jobs in Denver and apply to all of them")).toBeTruthy();
    expect(unsupportedByRules("Go to the next page and apply")).toBeTruthy();
    expect(unsupportedByRules("Fill out this application. Leave salary for me.")).toBeNull();
  });

  it("classifies Claude failures that mean 'unavailable'", () => {
    expect(classifyClaudeFailure("Invalid API key · Please run /login")).toMatch(/logged in/);
    expect(classifyClaudeFailure("Claude AI usage limit reached")).toMatch(/usage limit/);
    expect(classifyClaudeFailure("getaddrinfo ENOTFOUND api.anthropic.com")).toMatch(/network/);
    expect(classifyClaudeFailure("something else")).toBeNull();
  });
});
