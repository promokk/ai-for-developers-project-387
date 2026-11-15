import ast
import json
import sys


def module_name(path):
    return path.removeprefix("backend/").removesuffix(".py").replace("/", ".")


def test_definitions(source, module):
    if source is None:
        return {}
    tree = ast.parse(source)
    definitions = {}

    def collect(body, class_name=None):
        for node in body:
            if isinstance(
                node, ast.FunctionDef | ast.AsyncFunctionDef
            ) and node.name.startswith("test_"):
                className = f"{module}.{class_name}" if class_name else module
                definitions[(className, node.name)] = ast.dump(
                    node, include_attributes=False
                )
            elif isinstance(node, ast.ClassDef) and node.name.startswith("Test"):
                collect(node.body, node.name)

    collect(tree.body)
    return definitions


def changed_tests(changes):
    result = []
    for change in changes:
        module = module_name(change["path"])
        before = test_definitions(change["base"], module)
        after = test_definitions(change["current"], module)
        for (className, name), definition in after.items():
            if before.get((className, name)) != definition:
                result.append({"className": className, "name": name})
    return result


print(json.dumps(changed_tests(json.load(sys.stdin))))
