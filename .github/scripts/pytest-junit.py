import json
import re
import sys
import xml.etree.ElementTree as ET


def failure_type(failure):
    if failure.attrib.get("type"):
        return failure.attrib["type"]
    match = re.search(r":\d+: ([A-Za-z_][\w.]*)\s*$", failure.text or "")
    return match.group(1) if match else ""


def parse_report(path):
    root = ET.parse(path).getroot()
    tests = []
    for case in root.iter("testcase"):
        failure = case.find("failure")
        error = case.find("error")
        skipped = case.find("skipped")
        result = {
            "className": case.attrib.get("classname", ""),
            "name": case.attrib.get("name", ""),
            "status": "passed",
        }
        if error is not None:
            result["status"] = "error"
            result["errorType"] = error.attrib.get("type", "")
        elif failure is not None:
            result["status"] = "failed"
            result["failureType"] = failure_type(failure)
        elif skipped is not None:
            result["status"] = "skipped"
        tests.append(result)
    return {"tests": tests}


print(json.dumps(parse_report(sys.argv[1])))
