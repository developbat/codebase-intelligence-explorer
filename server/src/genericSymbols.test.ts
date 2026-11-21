import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeProject } from "./analyzer";

test("generic language parser extracts symbols and basic calls", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-generic-"));
  try {
    const files: Record<string, string> = {
      "main.go": `package main

type User struct {
  Name string
}

func Add(a, b int) int {
  return a + b
}

func (u *User) Greet() string {
  return u.Name
}

func main() {
  total := Add(1, 2)
  user := &User{Name: "a"}
  user.Greet()
  _ = total
}
`,
      "lib.rs": `struct User {
  name: String,
}

impl User {
  pub fn new() -> Self {
    User { name: String::new() }
  }

  fn greet(&self) -> String {
    self.name.clone()
  }
}

fn main() {
  let user = User::new();
  user.greet();
}
`,
      "User.java": `class User {
  private String name;

  public String getName() {
    return name;
  }
}
`,
      "user.rb": `class User
  def name
    "user"
  end
end
`,
      "User.swift": `struct User {
  func name() -> String {
    return "user"
  }
}
`,
      "Main.hs": `data User = User { userName :: String }

greet :: User -> String
greet user = userName user
`,
      "app.lua": `function greet(name)
  return name
end
`,
      "App.ps1": `function Get-User {
  return "user"
}
`,
      "Greeter.kt": `class Greeter {
  fun hello(): String {
    return "hello"
  }
}
`,
      "Shape.cpp": `class Shape {
public:
  int area() {
    return 1;
  }
};
`,
    };
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(root, name), content);
    }

    const analysis = await analyzeProject(root);
    const byQualified = new Map(analysis.symbols.map((symbol) => [symbol.qualifiedName, symbol]));
    const names = new Set(analysis.symbols.map((symbol) => symbol.name));

    for (const expected of ["User", "Add", "main", "greet", "Get-User", "hello", "area", "getName", "name", "new"]) {
      assert.ok(names.has(expected), `missing symbol ${expected}; got ${[...names].join(", ")}`);
    }
    assert.equal(byQualified.get("User")?.kind, "class");
    assert.equal(byQualified.get("User.Greet")?.kind, "method");
    assert.equal(byQualified.get("User.new")?.kind, "method");
    assert.equal(byQualified.get("User.greet")?.kind, "method");
    assert.equal(byQualified.get("User.getName")?.kind, "method");
    assert.equal(byQualified.get("User.name")?.kind, "method");
    assert.equal(byQualified.get("Greeter.hello")?.kind, "method");
    assert.equal(byQualified.get("Shape.area")?.kind, "method");

    const find = (filePath: string, qualifiedName: string) =>
      analysis.symbols.find(
        (symbol) => symbol.filePath === filePath && symbol.qualifiedName === qualifiedName,
      );
    const goMain = find("main.go", "main");
    const rustMain = find("lib.rs", "main");
    const add = find("main.go", "Add");
    const goGreet = find("main.go", "User.Greet");
    const rustNew = find("lib.rs", "User.new");
    assert.ok(goMain && rustMain && add && goGreet && rustNew);

    const calls = analysis.edges.filter((edge) => edge.kind === "CALLS");
    assert.ok(
      calls.some((edge) => edge.source === goMain.id && edge.target === add.id),
      "expected main.go main -> Add call edge",
    );
    assert.ok(
      calls.some((edge) => edge.source === goMain.id && edge.target === goGreet.id),
      "expected main.go main -> User.Greet call edge",
    );
    assert.ok(
      calls.some((edge) => edge.source === rustMain.id && edge.target === rustNew.id),
      "expected lib.rs main -> User.new call edge",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
