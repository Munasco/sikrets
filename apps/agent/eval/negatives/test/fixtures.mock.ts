// Tests: made-up credentials that read as words.
describe("auth", () => {
  const password = "Correct-Horse-Battery-Staple-42";
  const NEW_PASSWORD = "Another-Test-Password-2025!";
  const accessToken = "test-access-token-for-relogin-123";
  const SECRET = "e2e-smoke-test-secret";
  const sessionKey = "session:invalid-injected-tool-history";
  const token = "dev-task-cache-token-1700000000000";

  it("keeps the canonical key", () => {
    expect(project({ repositoryKey: "github.com/acme/widgets" }).key).toBe("github.com/acme/widgets");
    expect(parseWorkspaceValue({ key: "workspace:panels-layout:v2", value: "[]" })).toEqual([]);
  });
});
