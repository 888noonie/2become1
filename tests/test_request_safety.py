import asyncio

import httpx
import pytest
from fastapi import FastAPI, File, UploadFile

from twobecomeone.http_safety import RequestSafetyMiddleware


def make_app():
    app = FastAPI()
    app.state.calls = 0

    @app.post('/upload')
    def upload(file: UploadFile = File(...)):
        app.state.calls += 1
        return {'size': len(file.file.read())}

    @app.post('/change')
    def change():
        app.state.calls += 1
        return {'ok': True}

    app.add_middleware(RequestSafetyMiddleware, allowed_hosts={'localhost', '::1'}, max_body_bytes=300)
    return app


def test_host_origin_and_legitimate_requests():
    async def run():
        app = make_app()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://localhost') as c:
            assert (await c.post('/change', headers={'host': 'evil.example'})).status_code == 400
            assert (await c.post('/change', headers={'origin': 'https://evil.example'})).status_code == 403
            assert (await c.post('/change', headers={'origin': 'null'})).status_code == 403
            assert (await c.post('/change', headers={'sec-fetch-site': 'cross-site'})).status_code == 403
            assert app.state.calls == 0
            assert (await c.post('/change', headers={'origin': 'http://localhost'})).status_code == 200
            assert (await c.post('/change')).status_code == 200
            assert (await c.post('/upload', files={'file': ('a.wav', b'123')})).status_code == 200
    asyncio.run(run())


@pytest.mark.parametrize('declared', [None, '1', '1000'])
def test_large_stream_rejected_before_endpoint(declared):
    async def run():
        app = make_app()
        async def body():
            yield b'--b\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n\r\n'
            yield b'x' * 250
            yield b'\r\n--b--\r\n'
        headers = {'content-type': 'multipart/form-data; boundary=b'}
        if declared is not None:
            headers['content-length'] = declared
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://localhost') as c:
            r = await c.post('/upload', content=body(), headers=headers)
            assert r.status_code == 413, r.text
            assert r.json()['error']['code'] == 'payload_too_large'
            assert app.state.calls == 0
    asyncio.run(run())


def test_rejected_queue_submission_cleans_staged_upload(tmp_path, monkeypatch):
    from twobecomeone.webapp import create_app
    from twobecomeone.common import CapabilityError
    async def run():
        app = create_app(tmp_path)
        service = app.state.studio
        def reject(*args, **kwargs):
            raise CapabilityError('The job queue is full', code='queue_full')
        monkeypatch.setattr(service, 'submit_upload_import', reject)
        try:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://localhost') as c:
                r = await c.post('/api/imports/upload', files={'file': ('a.wav', b'123')})
                assert r.status_code == 503
                assert not list(service.incoming_dir.iterdir())
        finally:
            service.close()
    asyncio.run(run())
