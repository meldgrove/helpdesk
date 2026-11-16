import { describe, expect, it } from "vitest";
import { claimGroups, inGroup, roleFromGroups } from "./groups";

const groups = {
  requester: "/helpdesk/employees",
  operator: "/helpdesk/operators",
  admin: "helpdesk/admins",
  superadmin: null,
};

describe("groups", () => {
  it("matches a group and its subgroups, with or without slashes", () => {
    expect(inGroup("/helpdesk/operators", "/helpdesk/operators")).toBe(true);
    expect(inGroup("helpdesk/operators/", "/helpdesk/operators")).toBe(true);
    expect(inGroup("/helpdesk/operators/finance", "/helpdesk/operators")).toBe(true);
    expect(inGroup("/helpdesk/operators-old", "/helpdesk/operators")).toBe(false);
    expect(inGroup("/helpdesk", "/helpdesk/operators")).toBe(false);
  });

  it("gives the highest role", () => {
    expect(roleFromGroups(["/helpdesk/employees"], groups)).toBe("requester");
    expect(roleFromGroups(["/helpdesk/employees", "/helpdesk/admins"], groups)).toBe("admin");
    expect(roleFromGroups(["/helpdesk/operators/it"], groups)).toBe("operator");
    expect(roleFromGroups(["/other"], groups)).toBeNull();
    expect(roleFromGroups([], groups)).toBeNull();
  });

  it("reads a claim as a list", () => {
    expect(claimGroups(["/a", 3, "/b"])).toEqual(["/a", "/b"]);
    expect(claimGroups("/a")).toEqual(["/a"]);
    expect(claimGroups(undefined)).toEqual([]);
  });
});
