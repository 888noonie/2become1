"""Request guards applied before FastAPI parses uploads or dispatches routes."""
from urllib.parse import urlsplit

from starlette.datastructures import Headers
from starlette.formparsers import MultiPartException
from starlette.responses import JSONResponse

from .common import MAX_MEDIA_BYTES


class RequestSafetyMiddleware:
    def __init__(self, app, *, allowed_hosts, max_body_bytes=MAX_MEDIA_BYTES + 1024 * 1024):
        self.app = app
        self.allowed_hosts = frozenset(allowed_hosts)
        self.max_body_bytes = max_body_bytes

    @staticmethod
    def error(status, code, message):
        return JSONResponse({'error': {'code': code, 'message': message, 'detail': None}}, status_code=status)

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        headers = Headers(scope=scope)
        host = headers.get('host', '')
        try:
            parsed = urlsplit('//' + host)
            hostname = parsed.hostname
            if parsed.username is not None or parsed.path or parsed.query or parsed.fragment:
                hostname = None
            parsed.port  # reject malformed/out-of-range ports
        except ValueError:
            hostname = None
        if hostname not in self.allowed_hosts:
            return await self.error(400, 'invalid_host', 'Untrusted Studio host')(scope, receive, send)
        if scope['method'] not in {'GET', 'HEAD', 'OPTIONS'}:
            origin = headers.get('origin')
            if (origin is not None and origin != f"{scope['scheme']}://{host}") or headers.get('sec-fetch-site') == 'cross-site':
                return await self.error(403, 'invalid_origin', 'Cross-origin changes are not allowed')(scope, receive, send)
        limit = self.max_body_bytes
        if scope.get('path') not in {'/api/tracks', '/api/imports/upload'}:
            limit = min(limit, 1024 * 1024)
        content_length = headers.get('content-length')
        if content_length is not None:
            try:
                length = int(content_length)
                if length < 0:
                    raise ValueError
            except ValueError:
                return await self.error(400, 'invalid_length', 'Invalid request length')(scope, receive, send)
            if length > limit:
                return await self.error(413, 'payload_too_large', 'Request exceeds the upload limit')(scope, receive, send)

        consumed = 0
        exceeded = False
        replacement_sent = False

        async def limited_receive():
            nonlocal consumed, exceeded
            message = await receive()
            if message['type'] == 'http.request':
                consumed += len(message.get('body', b''))
                if consumed > limit:
                    exceeded = True
                    # Starlette's multipart parser closes its temporary files on
                    # this exception. The response below retains our 413 contract.
                    raise MultiPartException('Request exceeds the upload limit')
            return message

        async def guarded_send(message):
            nonlocal replacement_sent
            if exceeded:
                if not replacement_sent:
                    replacement_sent = True
                    await self.error(413, 'payload_too_large', 'Request exceeds the upload limit')(scope, receive, send)
                return
            await send(message)

        await self.app(scope, limited_receive, guarded_send)
