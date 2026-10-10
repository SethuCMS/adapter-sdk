"""
A minimal SethuCMS adapter in Python: an in-memory store with ONE collection.

It is a teaching example and a cross-language test, not a database adapter.
It is honest about what it cannot do: no filters, sort by key only. The gateway
refuses everything else before it reaches this file.

Run:   python3 -m pip install grpcio grpcio-tools
       python3 server.py --token "a-long-shared-secret" --port 50051
Test:  from the gateway repo, see apps/api/tests/grpc-python.test.ts
"""
import argparse
import hmac
import json
import os
import subprocess
import sys
from concurrent import futures

import grpc

HERE = os.path.dirname(os.path.abspath(__file__))
PROTO_ROOT = os.path.normpath(os.path.join(HERE, "..", "..", "proto"))
GEN = os.path.join(HERE, "_gen")


def generate():
    """Generate the Python stubs from the protocol file (once)."""
    os.makedirs(GEN, exist_ok=True)
    subprocess.check_call([
        sys.executable, "-m", "grpc_tools.protoc", f"-I{PROTO_ROOT}", f"--python_out={GEN}", f"--grpc_python_out={GEN}",
        os.path.join(PROTO_ROOT, "sethucms", "adapter", "v1", "adapter.proto"),
    ])


generate()
sys.path.insert(0, GEN)
from sethucms.adapter.v1 import adapter_pb2 as pb, adapter_pb2_grpc as rpc  # noqa: E402

COLLECTION = {
    "name": "items",
    "fields": [
        {"name": "id", "type": "integer", "primaryKey": True, "generated": True},
        {"name": "title", "type": "string", "required": True, "validation": {"maxLength": 200}},
        {"name": "score", "type": "integer"},
        {"name": "status", "type": "string"},
    ],
    "relations": [],
}
CAPABILITIES = {
    "joins": False, "transactions": "none",
    "filters": {"or": False, "inequality": "none", "fullText": False},
    "sort": "key-only", "pagination": {"cursor": True, "offset": False},
    "aggregations": False, "realtime": False, "schema": "inferred", "writes": True,
}


def matches(record, node):
    """Does the record satisfy the portable filter? (A filter is a comparison, or and / or / not of filters.)"""
    if "and" in node:
        return all(matches(record, child) for child in node["and"])
    if "or" in node:
        return any(matches(record, child) for child in node["or"])
    if "not" in node:
        return not matches(record, node["not"])
    value, op, wanted = record.get(node["field"]), node["op"], node.get("value")
    if op == "exists":
        return (value is not None) == bool(wanted if wanted is not None else True)
    if op == "eq":
        return value == wanted
    if op == "ne":
        return value != wanted
    if op == "in":
        return value in wanted
    if op == "nin":
        return value not in wanted
    if value is None:
        return False
    # Plain substring tests: user text is data, so "%" is just a character here.
    if op == "contains":
        return isinstance(value, str) and wanted in value
    if op == "startsWith":
        return isinstance(value, str) and value.startswith(wanted)
    if op == "lt":
        return value < wanted
    if op == "lte":
        return value <= wanted
    if op == "gt":
        return value > wanted
    if op == "gte":
        return value >= wanted
    return False


class SethuError(Exception):
    """A platform error: the code travels in the trailing metadata."""
    def __init__(self, code, message, status):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


class Adapter(rpc.AdapterServicer):
    def __init__(self, token):
        self.token = token.encode()
        self.rows = {}
        self.next_id = 1

    # -- plumbing ---------------------------------------------------------
    def _check(self, context):
        given = dict(context.invocation_metadata()).get("authorization", "").encode()
        if not hmac.compare_digest(given, b"Bearer " + self.token):
            raise SethuError("AUTH_FAILED", "Bad token", grpc.StatusCode.UNAUTHENTICATED)

    def _fail(self, context, error):
        context.set_trailing_metadata((("sethucms-error-code", error.code),))
        context.abort(error.status, error.message)

    def _run(self, context, work):
        try:
            self._check(context)
            return work()
        except SethuError as error:
            self._fail(context, error)
        except grpc.RpcError:
            raise
        except Exception:  # never leak internals
            self._fail(context, SethuError("INTERNAL", "Internal error", grpc.StatusCode.INTERNAL))

    # -- protocol ---------------------------------------------------------
    def Describe(self, request, context):
        return self._run(context, lambda: pb.DescribeReply(type="python-minimal", protocol_version="1", optional_calls=[]))

    def Connect(self, request, context):
        return self._run(context, lambda: pb.Empty())

    def Capabilities(self, request, context):
        return self._run(context, lambda: pb.JsonReply(json=json.dumps(CAPABILITIES)))

    def Introspect(self, request, context):
        return self._run(context, lambda: pb.JsonReply(json=json.dumps([COLLECTION])))

    def Find(self, request, context):
        def work():
            query = json.loads(request.query_json)
            limit = int(query["page"]["limit"])
            after = json.loads(request.position_json) if request.position_json else 0
            flt = query.get("filter")
            ids = sorted(i for i, row in self.rows.items() if i > after and (flt is None or matches(row, flt)))
            page = ids[:limit]
            more = len(ids) > limit
            records = [self.rows[i] for i in page]
            return pb.FindReply(records_json=json.dumps(records), next_position_json=json.dumps(page[-1]) if more else "")
        return self._run(context, work)

    def Get(self, request, context):
        def work():
            record = self.rows.get(self._id(request.id_json))
            return pb.GetReply(found=True, record_json=json.dumps(record)) if record else pb.GetReply(found=False)
        return self._run(context, work)

    def Create(self, request, context):
        def work():
            values = json.loads(request.values_json)
            record = {"id": self.next_id, "title": values.get("title"), "score": values.get("score"), "status": values.get("status")}
            self.rows[self.next_id] = record
            self.next_id += 1
            return pb.JsonReply(json=json.dumps(record))
        return self._run(context, work)

    def Update(self, request, context):
        def work():
            record = self.rows.get(self._id(request.id_json))
            if record is None:
                raise SethuError("NOT_FOUND", "Record not found", grpc.StatusCode.NOT_FOUND)
            record.update({k: v for k, v in json.loads(request.values_json).items() if k != "id"})
            return pb.JsonReply(json=json.dumps(record))
        return self._run(context, work)

    def Delete(self, request, context):
        def work():
            if self.rows.pop(self._id(request.id_json), None) is None:
                raise SethuError("NOT_FOUND", "Record not found", grpc.StatusCode.NOT_FOUND)
            return pb.Empty()
        return self._run(context, work)

    def Disconnect(self, request, context):
        return self._run(context, lambda: pb.Empty())

    @staticmethod
    def _id(raw):
        value = json.loads(raw)
        return int(value) if isinstance(value, (int, str)) and str(value).lstrip("-").isdigit() else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--token", required=True)
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=8))
    rpc.add_AdapterServicer_to_server(Adapter(args.token), server)
    port = server.add_insecure_port(f"127.0.0.1:{args.port}")
    server.start()
    print(f"LISTENING {port}", flush=True)
    server.wait_for_termination()


if __name__ == "__main__":
    main()
