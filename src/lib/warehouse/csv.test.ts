import { describe, it, expect } from "vitest";
import { csvCell, parseCsv, rowsToObjects, toCsv } from "./csv";

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, commas and line breaks inside fields", () => {
    expect(parseCsv('a,b,c\n"1,2","say ""hi""","two\nlines"\n')).toEqual([
      ["a", "b", "c"],
      ["1,2", 'say "hi"', "two\nlines"],
    ]);
  });

  it("accepts CRLF, a BOM and a last line without a newline", () => {
    expect(parseCsv("﻿x,y\r\n1,2")).toEqual([
      ["x", "y"],
      ["1", "2"],
    ]);
  });

  it("keeps empty fields", () => {
    expect(parseCsv("a,,c\n,,\n")).toEqual([
      ["a", "", "c"],
      ["", "", ""],
    ]);
  });
});

describe("rowsToObjects", () => {
  it("keys rows by the header and drops blank rows", () => {
    expect(rowsToObjects([["Code", "Zone"], ["01-01-1", "RTS"], ["", ""], ["IN-01"]])).toEqual([
      { Code: "01-01-1", Zone: "RTS" },
      { Code: "IN-01", Zone: "" },
    ]);
  });
});

describe("toCsv", () => {
  it("quotes only when needed and neutralises formula-like text", () => {
    expect(csvCell("02-01-2")).toBe("02-01-2");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell(-3.5)).toBe("-3.5");
    expect(csvCell(null)).toBe("");
    expect(csvCell(true)).toBe("true");
  });

  it("round-trips through parseCsv", () => {
    const rows = [
      ["code", "name"],
      ["ST-S1", "Pack station 1, by the door"],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});
