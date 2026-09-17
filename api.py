"""
API for LLM chat.
- Supports batch of multiple images
- Uses standard clip.tokenize mechanism like TextGenerate
- Parameters from request override cached values (no restart needed)
- _is_chat_generating flag allows workflow to wait for chat generation
"""

import json
import random
import time
import sys
import re
import asyncio
import base64
import io
import threading
from server import PromptServer
from aiohttp import web

routes = PromptServer.instance.routes

# ═══════════════════════════════════════
# ─── Cache ───
# ═══════════════════════════════════════
_cached_clip = None
_cached_params = {
    'max_length': 512,
    'temperature': 0.7,
    'top_k': 64,
    'top_p': 0.95,
    'repetition_penalty': 1.05,
    'seed': 777,
    'max_image_mp': 1.0,
    'token_limit': 4096,
}

_progress = {
    'active': False,
    'stage': '',
    'tokens_current': 0,
    'tokens_total': 0,
    'speed': 0.0,
    'elapsed': 0.0,
}

# Thread-safe flag indicating chat generation is in progress
_is_chat_generating = False
_generating_lock = threading.Lock()

# Thread-safe flag indicating workflow is executing iz_chat node
_workflow_running = False
_workflow_lock = threading.Lock()


def is_chat_generating():
    global _is_chat_generating
    with _generating_lock:
        return _is_chat_generating


def _set_generating(value):
    global _is_chat_generating
    with _generating_lock:
        _is_chat_generating = value
    print(f"[iz_chat API] _is_chat_generating = {value}")


def set_workflow_running(value):
    global _workflow_running
    with _workflow_lock:
        _workflow_running = value
    print(f"[iz_chat API] _workflow_running = {value}")


def is_workflow_running():
    global _workflow_running
    with _workflow_lock:
        return _workflow_running


def set_clip_model(clip):
    global _cached_clip
    _cached_clip = clip
    if clip is not None:
        tokenizer = getattr(clip, 'tokenizer', None)
        clip_name = getattr(tokenizer, 'clip_name', 'unknown') if tokenizer else 'unknown'
        print(f"[iz_chat API] CLIP cached: {type(clip).__name__}, clip_name={clip_name}")


def get_clip_model():
    return _cached_clip


def set_gen_params(**kwargs):
    global _cached_params
    _cached_params.update(kwargs)


# ═══════════════════════════════════════
# ─── Image downscaling ───
# ═══════════════════════════════════════
def resize_image_to_mp(img, max_mp, target_size=None):
    from PIL import Image
    import math

    W, H = img.size
    current_mp = (W * H) / 1_000_000

    if max_mp > 0 and current_mp > max_mp:
        scale = math.sqrt(max_mp / current_mp)
        new_W = max(1, int(W * scale))
        new_H = max(1, int(H * scale))
        img = img.resize((new_W, new_H), Image.LANCZOS)
        print(f"[iz_chat API] Downscale: {W}x{H} ({current_mp:.2f} MP) -> {new_W}x{new_H}")
    else:
        new_W, new_H = W, H

    if target_size is not None:
        tW, tH = target_size
        if (new_W, new_H) != (tW, tH):
            canvas = Image.new("RGB", (tW, tH), (0, 0, 0))
            offset_x = (tW - new_W) // 2
            offset_y = (tH - new_H) // 2
            canvas.paste(img, (offset_x, offset_y))
            img = canvas

    return img


def decode_image_from_base64(b64_data, max_mp=1.0):
    import torch
    import numpy as np
    from PIL import Image, ImageOps

    if not b64_data:
        return None

    b64_list = [b64_data] if isinstance(b64_data, str) else list(b64_data)
    print(f"[iz_chat API] Decoding {len(b64_list)} images, max_image_mp={max_mp}")

    decoded_images = []
    for i, b64 in enumerate(b64_list):
        if not b64:
            continue
        try:
            if ',' in b64:
                b64 = b64.split(',', 1)[1]

            img_bytes = base64.b64decode(b64)
            img = Image.open(io.BytesIO(img_bytes))
            img = ImageOps.exif_transpose(img)
            img = img.convert("RGB")

            print(f"[iz_chat API] Image {i+1}: {img.size}")

            img = resize_image_to_mp(img, max_mp)
            decoded_images.append(img)
        except Exception as e:
            print(f"[iz_chat API] Image {i+1} error: {e}")
            continue

    if not decoded_images:
        return None

    if len(decoded_images) == 1:
        img_np = np.array(decoded_images[0]).astype(np.float32) / 255.0
        result = torch.from_numpy(img_np).unsqueeze(0)
        print(f"[iz_chat API] 1 image: shape={tuple(result.shape)}")
        return result

    sizes = [img.size for img in decoded_images]
    unique_sizes = set(sizes)

    print(f"[iz_chat API] Image sizes: {sizes}")

    if len(unique_sizes) == 1:
        tensors = []
        for img in decoded_images:
            img_np = np.array(img).astype(np.float32) / 255.0
            tensors.append(torch.from_numpy(img_np))
        result = torch.stack(tensors, dim=0)
        print(f"[iz_chat API] Batch (same size): shape={tuple(result.shape)}")
        return result

    max_W = max(img.size[0] for img in decoded_images)
    max_H = max(img.size[1] for img in decoded_images)
    print(f"[iz_chat API] Resizing all to max size: {max_W}x{max_H}")

    tensors = []
    for i, img in enumerate(decoded_images):
        if img.size != (max_W, max_H):
            img = resize_image_to_mp(img, max_mp=0, target_size=(max_W, max_H))
        img_np = np.array(img).astype(np.float32) / 255.0
        tensors.append(torch.from_numpy(img_np))

    result = torch.stack(tensors, dim=0)
    print(f"[iz_chat API] Batch (different sizes, padding): shape={tuple(result.shape)}")
    return result


# ═══════════════════════════════════════
# ─── Tqdm interceptor ───
# ═══════════════════════════════════════
class TqdmInterceptor:
    PATTERN = re.compile(
        r'(\d+)/(\d+)\s+\[[\d:]+<[\d:]+,\s*([\d.]+)\s*(?:it/s|s/it)\]'
    )

    def __init__(self, original_stderr):
        self.original = original_stderr
        self.buffer = ""
        self.start_time = time.time()

    def write(self, text):
        self.original.write(text)
        self.buffer += text
        if len(self.buffer) > 2000:
            self.buffer = self.buffer[-500:]
        self._parse()

    def _parse(self):
        global _progress
        matches = self.PATTERN.findall(self.buffer)
        if matches:
            current_s, total_s, speed_s = matches[-1]
            _progress['active'] = True
            _progress['stage'] = 'generating'
            _progress['tokens_current'] = int(current_s)
            _progress['tokens_total'] = int(total_s)
            _progress['speed'] = float(speed_s)
            _progress['elapsed'] = time.time() - self.start_time
            self.buffer = ""

    def flush(self):
        self.original.flush()

    def fileno(self):
        return self.original.fileno()

    def isatty(self):
        return self.original.isatty()


# ═══════════════════════════════════════
# ─── Prompt building ───
# ═══════════════════════════════════════
def build_prompt(system_prompt, messages):
    parts = []

    if system_prompt and system_prompt.strip():
        parts.append(f"System: {system_prompt.strip()}")

    for msg in messages:
        role = msg.get('role', 'user')
        content = msg.get('content', '').strip()
        if not content:
            continue

        if role == 'user':
            parts.append(f"User: {content}")
        elif role == 'assistant':
            parts.append(f"Assistant: {content}")
        elif role == 'system':
            parts.append(f"System: {content}")

    parts.append("Assistant:")
    return "\n".join(parts)


def resolve_seed(seed, force_new=False):
    if force_new or not seed or seed == 0:
        return random.randint(1, 0xffffffffffffffff)
    return int(seed)


def _reset_progress(stage=""):
    global _progress
    _progress['active'] = True
    _progress['stage'] = stage
    _progress['tokens_current'] = 0
    _progress['tokens_total'] = int(_cached_params.get('max_length', 512))
    _progress['speed'] = 0.0
    _progress['elapsed'] = 0.0


def _finish_progress():
    global _progress
    _progress['active'] = False


# ═══════════════════════════════════════
# ─── Generation wrapper ───
# ═══════════════════════════════════════
def do_generate_sync(system_prompt, chat_history, image_b64=None,
                     seed_override=None, force_new_seed=False,
                     max_image_mp=None, max_length=None, seed=None):
    global _cached_clip

    if _cached_clip is None:
        return None, None, "CLIP model not loaded. Connect clip to iz_chat_cfg and run workflow."

    _set_generating(True)
    print("[iz_chat API] Generation started, workflow will wait if triggered")

    try:
        return _do_generate_inner(system_prompt, chat_history, image_b64,
                                  seed_override, force_new_seed,
                                  max_image_mp, max_length, seed)
    finally:
        _set_generating(False)
        print("[iz_chat API] Generation finished, workflow can proceed")


def _do_generate_inner(system_prompt, chat_history, image_b64=None,
                       seed_override=None, force_new_seed=False,
                       max_image_mp=None, max_length=None, seed=None):
    global _cached_clip, _cached_params

    start_time = time.time()
    _reset_progress("tokenizing")

    actual_max_length = int(max_length) if max_length is not None else int(_cached_params.get('max_length', 512))
    actual_max_image_mp = float(max_image_mp) if max_image_mp is not None else float(_cached_params.get('max_image_mp', 1.0))

    image_tensor = None
    if image_b64:
        image_tensor = decode_image_from_base64(image_b64, max_mp=actual_max_image_mp)
        if image_tensor is not None:
            print(f"[iz_chat API] {image_tensor.shape[0]} images ready")

    prompt = build_prompt(system_prompt, chat_history)
    print(f"[iz_chat API] Prompt ({len(prompt)} chars): {prompt[:400]}")

    try:
        tokenize_kwargs = {'min_length': 1, 'skip_template': False}

        if image_tensor is not None:
            tokenize_kwargs['image'] = image_tensor
            print(f"[iz_chat API] clip.tokenize with image={tuple(image_tensor.shape)}, skip_template=False")
        else:
            print(f"[iz_chat API] clip.tokenize without image, skip_template=False")

        tokens = _cached_clip.tokenize(prompt, **tokenize_kwargs)

        if isinstance(tokens, dict):
            print(f"[iz_chat API] Tokens: keys={list(tokens.keys())}")
            for k, v in tokens.items():
                if hasattr(v, 'shape'):
                    print(f"[iz_chat API]   {k}: shape={tuple(v.shape)}")

    except Exception as e:
        print(f"[iz_chat API] Tokenization error: {e}")
        import traceback
        traceback.print_exc()
        return None, None, f"Tokenization error: {str(e)}"

    if seed is not None and seed != 0:
        actual_seed = int(seed)
    elif seed_override is not None:
        actual_seed = int(seed_override)
    else:
        actual_seed = resolve_seed(_cached_params.get('seed', 777), force_new_seed)

    _progress['tokens_total'] = actual_max_length
    _reset_progress("generating")

    interceptor = TqdmInterceptor(sys.stderr)
    interceptor.start_time = start_time
    old_stderr = sys.stderr
    sys.stderr = interceptor

    try:
        print(f"[iz_chat API] Starting generation (seed={actual_seed}, max_length={actual_max_length})...")
        generated_ids = _cached_clip.generate(
            tokens,
            do_sample=True,
            max_length=actual_max_length,
            temperature=float(_cached_params.get('temperature', 0.7)),
            top_k=int(_cached_params.get('top_k', 64)),
            top_p=float(_cached_params.get('top_p', 0.95)),
            repetition_penalty=float(_cached_params.get('repetition_penalty', 1.05)),
            seed=actual_seed,
        )
    except Exception as e:
        print(f"[iz_chat API] Generation error: {e}")
        import traceback
        traceback.print_exc()
        sys.stderr = old_stderr
        return None, None, f"Generation error: {str(e)}"
    finally:
        sys.stderr = old_stderr

    _progress['stage'] = 'decoding'
    _progress['elapsed'] = time.time() - start_time

    response_text = _cached_clip.decode(generated_ids).strip()

    elapsed = time.time() - start_time
    _progress['stage'] = 'done'
    _progress['elapsed'] = elapsed

    img_info = f", {image_tensor.shape[0]} img" if image_tensor is not None else ""
    print(f"[iz_chat API] Response ({len(response_text)} chars, {elapsed:.1f}s{img_info})")
    print(f"[iz_chat API] Response: {response_text[:500]}")

    return response_text, actual_seed, None


# ═══════════════════════════════════════
# ─── POST /iz_chat/generate ───
# ═══════════════════════════════════════
@routes.post('/iz_chat/generate')
async def generate(request):
    try:
        data = await request.json()
        system_prompt = data.get('system_prompt', 'You are a helpful assistant.')
        chat_history = data.get('chat_history', [])
        image_b64 = data.get('image_b64', None)
        max_image_mp = data.get('max_image_mp', None)
        max_length = data.get('max_length', None)
        seed = data.get('seed', None)

        print(f"[iz_chat API] === /generate ===")
        print(f"[iz_chat API] chat_history: {len(chat_history)} messages, image: {'yes' if image_b64 else 'no'}")

        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            lambda: do_generate_sync(
                system_prompt, chat_history, image_b64,
                None, False, max_image_mp, max_length, seed
            )
        )

        response_text, actual_seed, error = result
        _finish_progress()

        if error:
            return web.json_response({'success': False, 'message': error})

        chat_history.append({"role": "assistant", "content": response_text})

        return web.json_response({
            'success': True,
            'response': response_text,
            'chat_history': chat_history,
            'seed': actual_seed,
        })

    except Exception as e:
        _finish_progress()
        import traceback
        traceback.print_exc()
        return web.json_response({'success': False, 'message': str(e)})


# ═══════════════════════════════════════
# ─── POST /iz_chat/regenerate ───
# ═══════════════════════════════════════
@routes.post('/iz_chat/regenerate')
async def regenerate(request):
    try:
        data = await request.json()
        system_prompt = data.get('system_prompt', 'You are a helpful assistant.')
        chat_history = data.get('chat_history', [])
        use_new_seed = data.get('use_new_seed', False)
        image_b64 = data.get('image_b64', None)
        max_image_mp = data.get('max_image_mp', None)
        max_length = data.get('max_length', None)
        seed = data.get('seed', None)

        print(f"[iz_chat API] === /regenerate === use_new_seed: {use_new_seed}")

        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            lambda: do_generate_sync(
                system_prompt, chat_history, image_b64,
                None, use_new_seed, max_image_mp, max_length, seed
            )
        )

        response_text, actual_seed, error = result
        _finish_progress()

        if error:
            return web.json_response({'success': False, 'message': error})

        return web.json_response({
            'success': True,
            'response': response_text,
            'seed': actual_seed,
        })

    except Exception as e:
        _finish_progress()
        import traceback
        traceback.print_exc()
        return web.json_response({'success': False, 'message': str(e)})


# ═══════════════════════════════════════
# ─── GET /iz_chat/progress ───
# ═══════════════════════════════════════
@routes.get('/iz_chat/progress')
async def progress(request):
    return web.json_response(_progress)


# ═══════════════════════════════════════
# ─── GET /iz_chat/status ───
# ═══════════════════════════════════════
@routes.get('/iz_chat/status')
async def status(request):
    return web.json_response({
        'model_loaded': _cached_clip is not None,
        'token_limit': _cached_params.get('token_limit', 4096),
        'is_generating': is_chat_generating(),
    })


# ═══════════════════════════════════════
# ─── GET /iz_chat/workflow_status ───
# ═══════════════════════════════════════
@routes.get('/iz_chat/workflow_status')
async def workflow_status(request):
    return web.json_response({
        'workflow_running': is_workflow_running(),
    })


# ═══════════════════════════════════════
# ─── GET /iz_chat/queue_status ───
# ═══════════════════════════════════════
@routes.get('/iz_chat/queue_status')
async def queue_status(request):
    """
    Checks prompt queue DIRECTLY on server.
    Detects ANY running workflow, not just those with iz_chat node.
    """
    try:
        prompt_queue = PromptServer.instance.prompt_queue

        running = 0
        pending = 0

        with prompt_queue.mutex:
            if hasattr(prompt_queue, 'currently_running'):
                running = len(prompt_queue.currently_running)
            if hasattr(prompt_queue, 'queue'):
                pending = len(prompt_queue.queue)

        active = running > 0 or pending > 0

        return web.json_response({
            'running': running,
            'pending': pending,
            'active': active,
        })
    except Exception as e:
        print(f"[iz_chat API] queue_status error: {e}")
        return web.json_response({
            'running': 0,
            'pending': 0,
            'active': False,
            'error': str(e),
        })
