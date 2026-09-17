"""
Nodes for LLM chat using standard ComfyUI CLIP interface.

- iz_chat     — chat node (accepts cfg, system_prompt, image)
- iz_chat_cfg — generation settings node (accepts clip, returns cfg)

Workflow execution is ONLY for loading the model.
All generation happens through API (chat UI).
"""

import json
import time
from . import api as chat_api


class LLMChatCfgNode:
    """Generation settings for iz_chat (includes CLIP loader)"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP", {
                    "tooltip": "CLIP model from CLIPLoader"
                }),
                "max_length": ("INT", {
                    "default": 512,
                    "min": 1,
                    "max": 32768,
                    "tooltip": "Maximum generation length in tokens"
                }),
                "temperature": ("FLOAT", {
                    "default": 0.7,
                    "min": 0.01,
                    "max": 2.0,
                    "step": 0.01,
                    "tooltip": "Generation temperature"
                }),
                "top_k": ("INT", {
                    "default": 64,
                    "min": 0,
                    "max": 1000,
                    "tooltip": "Top-K sampling"
                }),
                "top_p": ("FLOAT", {
                    "default": 0.95,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "tooltip": "Top-P (nucleus) sampling"
                }),
                "repetition_penalty": ("FLOAT", {
                    "default": 1.05,
                    "min": 0.0,
                    "max": 5.0,
                    "step": 0.01,
                    "tooltip": "Repetition penalty"
                }),
                "seed": ("INT", {
                    "default": 777,
                    "min": 0,
                    "max": 0xffffffffffffffff,
                    "tooltip": "Seed for reproducibility"
                }),
                "max_image_mp": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.1,
                    "max": 10.0,
                    "step": 0.1,
                    "tooltip": "Max image size in megapixels. Larger images will be downscaled."
                }),
                "token_limit": ("INT", {
                    "default": 4096,
                    "min": 256,
                    "max": 128000,
                    "step": 256,
                    "tooltip": "Token limit (statistical only, does not block anything)"
                }),
            }
        }

    RETURN_TYPES = ("IZ_CHAT_CFG",)
    RETURN_NAMES = ("cfg",)
    FUNCTION = "get_cfg"
    CATEGORY = "IZmake/iz_chat"
    DESCRIPTION = "Generation settings for iz_chat"

    def get_cfg(self, clip, max_length, temperature, top_k, top_p,
                repetition_penalty, seed, max_image_mp, token_limit):
        chat_api.set_clip_model(clip)

        cfg = {
            "max_length": int(max_length),
            "temperature": float(temperature),
            "top_k": int(top_k),
            "top_p": float(top_p),
            "repetition_penalty": float(repetition_penalty),
            "seed": int(seed),
            "max_image_mp": float(max_image_mp),
            "token_limit": int(token_limit),
        }

        print(f"[iz_chat] cfg cached: max_length={max_length}, token_limit={token_limit}, max_image_mp={max_image_mp}")
        return (cfg,)


class LLMChatNode:
    """Chat with local LLM model via CLIP (with image support)"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "cfg": ("IZ_CHAT_CFG", {
                    "tooltip": "Generation settings from iz_chat_cfg"
                }),
                "system_prompt": ("STRING", {
                    "default": "You are a helpful assistant.",
                    "multiline": False,
                    "tooltip": "System prompt"
                }),
                "chat_history": ("STRING", {
                    "default": "[]",
                    "multiline": False,
                    "tooltip": "Chat history (managed via UI)"
                }),
            },
            "optional": {
                "image": ("IMAGE", {
                    "tooltip": "Optional images (1 or batch) for Vision-Language model"
                }),
            }
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("full_chat", "last_response")
    FUNCTION = "process_chat"
    CATEGORY = "IZmake/iz_chat"
    DESCRIPTION = "Chat with LLM model (with image support) via ComfyUI CLIP"

    @classmethod
    def IS_CHANGED(cls, cfg, system_prompt, chat_history, image=None):
        """
        Forces this node to ALWAYS execute when workflow runs.
        Without this, ComfyUI caches the result and skips process_chat
        if inputs haven't changed — which breaks the wait-for-generation logic.
        Returning NaN guarantees the node is never cached.
        """
        return float("NaN")

    def process_chat(self, cfg, system_prompt, chat_history, image=None):
        """
        Caches settings for API access.
        Waits for chat generation to finish if it's currently running.
        Sets _workflow_running flag so chat UI knows workflow is executing.
        Does NOT generate — workflow execution is only for loading the model.
        """
        print(f"[iz_chat] process_chat called, is_chat_generating={chat_api.is_chat_generating()}")

        # Set workflow running flag (chat UI will block sending)
        chat_api.set_workflow_running(True)

        try:
            # Wait for chat generation to finish if it's running
            max_wait = 300
            waited = 0
            while chat_api.is_chat_generating() and waited < max_wait:
                time.sleep(0.5)
                waited += 0.5
                if int(waited) % 5 == 0:
                    print(f"[iz_chat] Waiting for chat generation to finish... ({int(waited)}s)")

            if chat_api.is_chat_generating():
                print("[iz_chat] WARNING: Chat generation still running after timeout, proceeding anyway")
            elif waited > 0:
                print(f"[iz_chat] Chat generation finished, proceeding with workflow (waited {waited:.1f}s)")
            else:
                print("[iz_chat] No active chat generation, proceeding immediately")

            # Cache settings
            chat_api.set_gen_params(**cfg)

            max_mp = cfg.get('max_image_mp', 1.0)
            token_limit = cfg.get('token_limit', 4096)

            if image is not None and hasattr(image, 'shape'):
                print(f"[iz_chat] Settings cached, {image.shape[0]} images, max_image_mp={max_mp}, token_limit={token_limit}")
            else:
                print(f"[iz_chat] Settings cached, no images, max_image_mp={max_mp}, token_limit={token_limit}")

            try:
                history = json.loads(chat_history) if chat_history else []
            except json.JSONDecodeError:
                history = []

            if not history:
                return ("Chat is empty. Enter a message in the node interface.", "")

            last_response = ""
            for msg in reversed(history):
                if msg.get('role') == 'assistant':
                    last_response = msg.get('content', '')
                    break

            full_chat = self.format_chat(history)

            return (full_chat, last_response)

        finally:
            # Always clear workflow running flag
            chat_api.set_workflow_running(False)

    def format_chat(self, history):
        """Formats chat history for output"""
        lines = []
        for msg in history:
            role = msg.get('role', 'unknown')
            content = msg.get('content', '')

            if role == 'user':
                prefix = "👤 User"
            elif role == 'assistant':
                prefix = "🤖 Assistant"
            elif role == 'system':
                prefix = "⚙️ System"
            else:
                prefix = f"❓ {role}"

            lines.append(f"{prefix}: {content}")

        return "\n\n".join(lines)


NODE_CLASS_MAPPINGS = {
    "iz_chat": LLMChatNode,
    "iz_chat_cfg": LLMChatCfgNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "iz_chat": "iz chat",
    "iz_chat_cfg": "iz chat cfg",
}
