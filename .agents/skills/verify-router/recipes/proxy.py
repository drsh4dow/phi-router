import json, os, socket, sys, threading

log = open(sys.argv[1], "a", buffering=1)
canary = os.environ["CANARY"].encode()


def handle(c):
    c.settimeout(2)
    data = b""
    try:
        while b"\r\n\r\n" not in data:
            chunk = c.recv(65536)
            if not chunk:
                return
            data += chunk
        first = data.split(b"\r\n", 1)[0].decode(errors="replace")
        if first.startswith("CONNECT"):
            c.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
        try:
            while chunk := c.recv(65536):
                data += chunk
        except socket.timeout:
            pass
        log.write(json.dumps({"request": first, "canary": canary in data}) + "\n")
        c.sendall(b"HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
    except OSError:
        pass
    finally:
        c.close()


listener = socket.create_server(("127.0.0.1", 0))
print(f"http://127.0.0.1:{listener.getsockname()[1]}", flush=True)
while True:
    threading.Thread(target=handle, args=(listener.accept()[0],), daemon=True).start()
