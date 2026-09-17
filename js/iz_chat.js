import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

app.registerExtension({
    name: "iz_chat.LLMChat",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {

        const TEXT_SET_NODE_NAME = "text_to_iz_chat";
        const IMAGE_SET_NODE_NAME = "img_to_iz_chat";

        if (nodeData.name === "iz_chat_cfg") {
            const onCfg = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                onCfg?.apply(this, arguments);
                setTimeout(() => {
                    const cw = this.widgets?.find(w => w.name === "control_after_generate");
                    if (cw) cw.value = "fixed";
                }, 0);
            };
            return;
        }

        if (nodeData.name !== "iz_chat") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;

        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            const node = this;

            let chatHistory = [];
            let isGenerating = false;
            let isWorkflowRunning = false;
            let currentWidth = node.size?.[0] || 420;
            let editingIndex = -1;
            let progressInterval = null;
            let loadedImageSizes = [];
            let regenButtons = [];

            api.addEventListener("execution_start", () => {
                isWorkflowRunning = true;
                updateButtonsState();
                if (!isGenerating) setStatus("workflow running... you can type, send after finish", "#fa6");
            });
            api.addEventListener("execution_success", () => {
                isWorkflowRunning = false;
                updateButtonsState();
                if (!isGenerating) setStatus("ready to chat", "#bbb");
            });
            api.addEventListener("execution_error", () => {
                isWorkflowRunning = false;
                updateButtonsState();
                if (!isGenerating) setStatus("ready to chat", "#bbb");
            });
            api.addEventListener("execution_interrupted", () => {
                isWorkflowRunning = false;
                updateButtonsState();
                if (!isGenerating) setStatus("ready to chat (interrupted)", "#bbb");
            });

            const chatHistoryWidget = node.widgets.find(w => w.name === "chat_history");
            if (chatHistoryWidget) {
                chatHistoryWidget.type = "converted-widget";
                chatHistoryWidget.computeSize = () => [0, -4];
                chatHistoryWidget.serializeValue = () => chatHistoryWidget.value;
                chatHistoryWidget.draw = function () {};
                setTimeout(() => {
                    if (chatHistoryWidget.element) {
                        chatHistoryWidget.element.style.display = "none";
                        chatHistoryWidget.element.style.position = "absolute";
                        chatHistoryWidget.element.style.left = "-9999px";
                        chatHistoryWidget.element.style.width = "0";
                        chatHistoryWidget.element.style.height = "0";
                    }
                }, 100);
                Object.defineProperty(chatHistoryWidget, "hidden", { value: true, writable: false });
            }

            const onResize = node.onResize;
            node.onResize = function (size) { currentWidth = size[0]; onResize?.apply(this, arguments); };

            const styleId = "iz-chat-styles";
            if (!document.getElementById(styleId)) {
                const style = document.createElement("style");
                style.id = styleId;
                style.textContent = `
                    .iz-chat-container { display: flex; flex-direction: column; gap: 8px; padding: 10px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; border-radius: 8px; background: #1a1a24; }
                    .iz-chat-status { text-align: center; padding: 3px 0; font-size: 12px; color: #bbb; letter-spacing: 0.3px; min-height: 16px; transition: color 0.3s; font-family: monospace; }
                    .iz-chat-image-status { text-align: center; font-size: 11px; color: #999; padding: 2px 0; font-family: monospace; min-height: 14px; }
                    .iz-progress-wrap { display: flex; flex-direction: column; gap: 3px; }
                    .iz-progress-track { height: 6px; width: 100%; background: #0e0e16; border-radius: 3px; overflow: hidden; border: 1px solid #2a2a3a; }
                    .iz-progress-fill { height: 100%; width: 0%; background: #4a9a5a; border-radius: 2px; transition: width 0.3s ease; }
                    .iz-progress-fill.over-limit { background: #e05555; }
                    .iz-progress-fill.generating { background: linear-gradient(90deg, #4a7aff, #8a5aff) !important; }
                    .iz-progress-info { display: flex; justify-content: space-between; font-size: 11px; font-family: monospace; color: #aaa; padding: 0 2px; }
                    .iz-progress-tokens { color: #8f8; }
                    .iz-progress-tokens.danger { color: #f66; font-weight: bold; }
                    .iz-progress-speed { color: #aa8aff; }
                    .iz-chat-messages { display: flex; flex-direction: column; gap: 6px; padding: 10px; background: #14141e; border: 1px solid #2a2a3a; border-radius: 8px; height: 320px; overflow-y: auto; font-size: 12px; scrollbar-width: thin; scrollbar-color: #3a3a5a #14141e; }
                    .iz-chat-messages::-webkit-scrollbar { width: 5px; }
                    .iz-chat-messages::-webkit-scrollbar-track { background: #14141e; }
                    .iz-chat-messages::-webkit-scrollbar-thumb { background: #3a3a5a; border-radius: 3px; }
                    .iz-msg { position: relative; padding: 8px 10px; padding-right: 12px; border-radius: 6px; color: #ddd; white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
                    .iz-msg:hover .iz-msg-controls { opacity: 1; }
                    .iz-msg-user { background: linear-gradient(135deg, #1e2a4a 0%, #1a2440 100%); border-left: 2px solid #4a7aff; }
                    .iz-msg-assistant { background: linear-gradient(135deg, #2a1e4a 0%, #241a40 100%); border-left: 2px solid #8a5aff; }
                    .iz-msg-system { background: #1e1e28; border-left: 2px solid #555; }
                    .iz-msg-label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; display: block; }
                    .iz-msg-user .iz-msg-label { color: #6a9aff; }
                    .iz-msg-assistant .iz-msg-label { color: #aa7aff; }
                    .iz-msg-system .iz-msg-label { color: #888; }
                    .iz-msg-seed-row { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; gap: 6px; }
                    .iz-msg-seed { font-size: 9px; color: #556; font-family: monospace; }
                    .iz-msg-copy { background: transparent; border: none; color: #556; font-size: 10px; cursor: pointer; padding: 1px 4px; border-radius: 3px; transition: all 0.15s; line-height: 1; }
                    .iz-msg-copy:hover { color: #8abaff; background: rgba(100,180,255,0.1); }
                    .iz-msg-controls { position: absolute; top: 4px; right: 4px; display: flex; gap: 2px; opacity: 0; transition: opacity 0.2s; }
                    .iz-msg-btn { width: 20px; height: 20px; font-size: 11px; background: rgba(0,0,0,0.3); border: none; cursor: pointer; border-radius: 4px; display: flex; align-items: center; justify-content: center; color: #999; transition: all 0.15s; padding: 0; }
                    .iz-msg-btn:hover { background: rgba(255,255,255,0.15); color: #fff; }
                    .iz-msg-btn-del:hover { background: rgba(255,80,80,0.25); color: #ff6b6b; }
                    .iz-msg-btn-regen:hover { background: rgba(100,180,255,0.2); color: #6baaff; }
                    .iz-msg-btn-anchor:hover { background: rgba(255,200,80,0.2); color: #ffcc66; }
                    .iz-msg-btn:disabled { opacity: 0.3; cursor: not-allowed; }
                    .iz-msg-btn:disabled:hover { background: rgba(0,0,0,0.3); color: #999; }
                    .iz-chat-input-row { display: flex; gap: 6px; align-items: center; }
                    .iz-chat-input { flex: 1; padding: 6px 10px; font-size: 13px; border: 1px solid #2a2a3a; border-radius: 6px; background: #14141e; color: #eee; font-family: inherit; resize: none; box-sizing: border-box; transition: border-color 0.2s; outline: none; line-height: 1.4; overflow-y: auto; min-height: 66px; max-height: 110px; }
                    .iz-chat-input:focus { border-color: #4a6a9a; }
                    .iz-chat-input::placeholder { color: #445; }
                    .iz-chat-send { width: 32px; height: 32px; border: 1px solid #2a3a5a; border-radius: 6px; cursor: pointer; background: linear-gradient(135deg, #2a4a7a 0%, #1e3a6a 100%); color: #8abaff; font-size: 16px; display: flex; align-items: center; justify-content: center; transition: all 0.15s; flex-shrink: 0; padding: 0; font-weight: bold; }
                    .iz-chat-send:hover { background: linear-gradient(135deg, #3a5a9a 0%, #2a4a8a 100%); color: #aadaff; }
                    .iz-chat-send:disabled { opacity: 0.4; cursor: not-allowed; }
                    .iz-chat-generate { padding: 8px 0; font-size: 12px; border: 1px solid #3a5a8a; border-radius: 6px; cursor: pointer; background: linear-gradient(135deg, #2a4a7a 0%, #1e3a6a 100%); color: #aadaff; width: 100%; transition: all 0.15s; letter-spacing: 0.3px; display: none; font-weight: 500; }
                    .iz-chat-generate:hover { background: linear-gradient(135deg, #3a5a9a 0%, #2a4a8a 100%); color: #ccecff; }
                    .iz-chat-generate:disabled { opacity: 0.4; cursor: not-allowed; }
                    .iz-chat-generate.visible { display: block; }
                    .iz-chat-clear { padding: 6px 0; font-size: 11px; border: 1px solid #4a3a3a; border-radius: 6px; cursor: pointer; background: #2a2020; color: #cc9999; width: 100%; transition: all 0.15s; letter-spacing: 0.3px; }
                    .iz-chat-clear:hover { background: #3a2a2a; color: #ffaaaa; border-color: #6a4a4a; }
                    .iz-chat-empty { color: #667; text-align: center; padding: 24px 10px; font-size: 12px; font-style: italic; }
                    .iz-edit-area { width: 100%; padding: 6px 8px; font-size: 12px; font-family: inherit; background: #0e0e16; color: #eee; border: 1px solid #4a6a9a; border-radius: 4px; resize: vertical; box-sizing: border-box; outline: none; }
                    .iz-edit-controls { display: flex; gap: 4px; margin-top: 4px; }
                    .iz-edit-controls button { padding: 4px 12px; font-size: 11px; border: none; border-radius: 4px; cursor: pointer; transition: filter 0.15s; }
                    .iz-edit-controls button:hover { filter: brightness(1.2); }
                    .iz-edit-save { background: #2a6a4a; color: #aaffcc; }
                    .iz-edit-cancel { background: #5a2a2a; color: #ffaaaa; }
                `;
                document.head.appendChild(style);
            }

            const container = document.createElement("div");
            container.className = "iz-chat-container";
            const status = document.createElement("div");
            status.className = "iz-chat-status";
            status.textContent = "ready to chat";
            container.appendChild(status);
            const progressWrap = document.createElement("div");
            progressWrap.className = "iz-progress-wrap";
            const progressTrack = document.createElement("div");
            progressTrack.className = "iz-progress-track";
            const progressFill = document.createElement("div");
            progressFill.className = "iz-progress-fill";
            progressTrack.appendChild(progressFill);
            progressWrap.appendChild(progressTrack);
            const progressInfo = document.createElement("div");
            progressInfo.className = "iz-progress-info";
            const progressStage = document.createElement("span");
            progressStage.textContent = "";
            const progressTokens = document.createElement("span");
            progressTokens.className = "iz-progress-tokens";
            const progressSpeed = document.createElement("span");
            progressSpeed.className = "iz-progress-speed";
            progressInfo.append(progressStage, progressTokens, progressSpeed);
            progressWrap.appendChild(progressInfo);
            container.appendChild(progressWrap);
            const imgStatus = document.createElement("div");
            imgStatus.className = "iz-chat-image-status";
            imgStatus.textContent = "";
            container.appendChild(imgStatus);
            const chatContainer = document.createElement("div");
            chatContainer.className = "iz-chat-messages";
            container.appendChild(chatContainer);
            const inputRow = document.createElement("div");
            inputRow.className = "iz-chat-input-row";
            const inputField = document.createElement("textarea");
            inputField.className = "iz-chat-input";
            inputField.placeholder = "type a message...";
            inputField.rows = 3;
            inputRow.appendChild(inputField);
            const sendBtn = document.createElement("button");
            sendBtn.className = "iz-chat-send";
            sendBtn.innerHTML = "↑";
            sendBtn.title = "Send message";
            inputRow.appendChild(sendBtn);
            container.appendChild(inputRow);
            const generateBtn = document.createElement("button");
            generateBtn.className = "iz-chat-generate";
            generateBtn.innerHTML = "⟳ generate response";
            generateBtn.title = "Generate response to the last user message";
            container.appendChild(generateBtn);
            const clearBtn = document.createElement("button");
            clearBtn.className = "iz-chat-clear";
            clearBtn.textContent = "clear chat";
            clearBtn.title = "Clear all history";
            container.appendChild(clearBtn);

            function updateButtonsState() {
                const blocked = isGenerating || isWorkflowRunning;
                sendBtn.disabled = blocked;
                generateBtn.disabled = blocked;
                for (const btn of regenButtons) btn.disabled = blocked;
                inputField.disabled = false;
                inputField.style.opacity = "1";
            }

            async function isServerQueueActive() {
                try { const resp = await fetch("/iz_chat/queue_status"); const data = await resp.json(); return data.active; }
                catch (e) { return false; }
            }
            async function isNodeWorkflowRunning() {
                try { const resp = await fetch("/iz_chat/workflow_status"); const data = await resp.json(); return data.workflow_running; }
                catch (e) { return false; }
            }
            async function isAnyWorkflowActive() {
                if (await isServerQueueActive()) return true;
                return await isNodeWorkflowRunning();
            }

            function autoResizeInput() {
                inputField.style.height = "auto";
                const lineHeight = 18;
                const scrollH = inputField.scrollHeight;
                const minH = lineHeight * 3 + 12;
                const maxH = lineHeight * 5 + 12;
                inputField.style.height = Math.max(minH, Math.min(scrollH, maxH)) + "px";
            }
            inputField.oninput = autoResizeInput;
            setTimeout(autoResizeInput, 100);

            // ═══════════════════════════════════════
            // ─── NODE TYPE HELPERS ───
            // ═══════════════════════════════════════

            function isNodeInactive(n) {
                if (!n) return true;
                return n.mode === 2 || n.mode === 4;
            }

            function isRouterNode(nodeType) {
                if (!nodeType) return false;
                const t = nodeType.toLowerCase();
                if (t.includes("fast muter") || t.includes("fastmuter")) return true;
                if (t.includes("fast bypass")) return true;
                if (t === "switch" || t === "router" || t === "select" || t === "mux") return true;
                if (t.includes("pass") && t.includes("through")) return true;
                if (t === "reroute") return true;
                return false;
            }

            function isAnySwitchNode(nodeType) {
                if (!nodeType) return false;
                const t = nodeType.toLowerCase();
                return t.includes("anyswitch") || t.includes("any switch");
            }

            /**
             * Detects ANY Get Node.
             * Matches: GetNode, GetNode[Any], FastContextGet,
             * Get_text_to_iz_chat (custom), get node, etc.
             */
            function isGetNode(srcNode) {
                if (!srcNode || !srcNode.type) return false;
                const t = srcNode.type.toLowerCase();
                if (t.startsWith("get_")) return true;           // Get_text_to_iz_chat
                if (t.startsWith("get")) return true;           // GetNode, GetNode[Any], GetAnything
                if (t.includes("getnode")) return true;
                if (t.includes("get_node")) return true;
                if (t.includes("get node")) return true;
                if (t.includes("fastcontextget")) return true;
                if (t.includes("fast context get")) return true;
                if (t.includes("contextget")) return true;
                if (t.includes("context get")) return true;
                if (t.includes("kj") && t.includes("get")) return true;
                return false;
            }

            /**
             * Detects ANY Set Node.
             * Matches: SetNode, SetNode[Any], FastContextSet,
             * Set_text_to_iz_chat (custom), set node, etc.
             * to support custom-named Set nodes like "Set_text_to_iz_chat".
             */
            function isSetNode(srcNode) {
                if (!srcNode || !srcNode.type) return false;
                const t = srcNode.type.toLowerCase();
                if (t.startsWith("set_")) return true;           // Set_text_to_iz_chat ← THIS!
                if (t.startsWith("set")) return true;           // SetNode, SetNode[Any], SetAnything
                if (t.includes("setnode")) return true;
                if (t.includes("set_node")) return true;
                if (t.includes("set node")) return true;
                if (t.includes("fastcontextset")) return true;
                if (t.includes("fast context set")) return true;
                if (t.includes("contextset")) return true;
                if (t.includes("context set")) return true;
                if (t.includes("kj") && t.includes("set")) return true;
                return false;
            }

            /**
             * Gets the "name" value from a Set/Get Node.
             * Checks many possible widget names.
             *
             * IMPORTANT: This returns the VALUE in the widget (e.g., "text_to_iz_chat"),
             * NOT the node type (e.g., "Set_text_to_iz_chat").
             */
            function getGetSetName(n) {
                if (!n || !n.widgets) return null;
                const nameKeys = [
                    "name", "set_name", "node_name", "setname", "nodename",
                    "context_name", "contextname", "key", "id", "label",
                    "get_name", "getname", "identifier", "bus_name", "busname"
                ];
                for (const w of n.widgets) {
                    const wName = (w.name || "").toLowerCase();
                    if (nameKeys.includes(wName)) {
                        if (w.value !== undefined && w.value !== null && w.value !== "") {
                            return w.value;
                        }
                    }
                }
                // Fallback: return the first string widget value
                for (const w of n.widgets) {
                    if (typeof w.value === 'string' && w.value.length > 0 && w.value.length < 100) {
                        return w.value;
                    }
                }
                return null;
            }

            /**
             * Gets all nodes from the current graph (workflow).
             * These are the SAME nodes visible in ComfyUI canvas.
             */
            function getAllGraphNodes() {
                if (app.graph) {
                    if (app.graph._nodes && app.graph._nodes.length > 0) return app.graph._nodes;
                    if (app.graph.nodes && app.graph.nodes.length > 0) return app.graph.nodes;
                    if (app.graph._nodes_by_id) return Object.values(app.graph._nodes_by_id);
                }
                return [];
            }

            /**
             * Debug: lists ALL nodes whose type contains "set" or "get".
             * Shows: type, id, mode, and ALL widgets with their values.
             *
             * Called at startup AND when searching for Set Node (so you see
             * exactly what's happening).
             */
            function debugListSetGetNodes(context) {
                const nodes = getAllGraphNodes();
                if (nodes.length === 0) {
                    console.log(`[iz_chat] ${context}: No nodes in graph`);
                    return;
                }

                console.log(`\n[iz_chat] ═══ DEBUG ${context}: Set/Get nodes (${nodes.length} total nodes) ═══`);
                let found = 0;
                for (const n of nodes) {
                    if (!n || !n.type) continue;
                    const t = n.type.toLowerCase();
                    if (t.includes("set") || t.includes("get") || t.includes("context")) {
                        found++;
                        const widgetList = n.widgets ? n.widgets.map(w => {
                            const v = typeof w.value === 'string' && w.value.length > 50
                                ? w.value.substring(0, 50) + "..." : w.value;
                            return `${w.name}="${v}"`;
                        }).join(", ") : "no widgets";
                        console.log(`[iz_chat]   [${found}] type="${n.type}" id=${n.id} mode=${n.mode} inactive=${isNodeInactive(n)}`);
                        console.log(`[iz_chat]       widgets: ${widgetList}`);
                        console.log(`[iz_chat]       inputs: ${n.inputs ? n.inputs.length : 0}, outputs: ${n.outputs ? n.outputs.length : 0}`);
                        console.log(`[iz_chat]       isSetNode=${isSetNode(n)}, isGetNode=${isGetNode(n)}, setName="${getGetSetName(n)}"`);
                    }
                }
                if (found === 0) {
                    console.log(`[iz_chat]   No Set/Get nodes found in graph`);
                }
                console.log(`[iz_chat] ═══ END DEBUG ═══\n`);
            }

            /**
             * Finds a Set Node whose WIDGET VALUE matches targetName.
             *
             * Example: targetName = "text_to_iz_chat"
             *   → Finds node with type "Set_text_to_iz_chat" whose widget
             *     "name" has value "text_to_iz_chat".
             *
             * Searches ALL nodes in the current workflow.
             */
            function findSetNodeByName(targetName) {
                if (!targetName) return null;

                const nodes = getAllGraphNodes();
                if (nodes.length === 0) return null;

                for (const n of nodes) {
                    if (!n || !n.type) continue;
                    if (!isSetNode(n)) continue;
                    if (isNodeInactive(n)) continue;

                    const widgetValue = getGetSetName(n);
                    if (widgetValue === targetName) {
                        return n;
                    }
                }

                return null;
            }

            function extractFromLastOutput(lastOutput, slotIndex) {
                if (lastOutput === undefined || lastOutput === null) return null;

                if (typeof lastOutput === 'object' && !Array.isArray(lastOutput)) {
                    let v = lastOutput[slotIndex];
                    if (v === undefined) v = lastOutput[0];
                    if (v === undefined) v = lastOutput['result'];
                    if (v === undefined) v = lastOutput['text'];
                    if (v === undefined) v = lastOutput['output'];
                    if (v === undefined) v = lastOutput['images'];
                    if (Array.isArray(v) && v.length > 0) v = v[0];
                    if (v !== undefined && v !== null && v !== "") return v;
                }

                if (Array.isArray(lastOutput)) {
                    let v = lastOutput[slotIndex];
                    if (v === undefined) v = lastOutput[0];
                    if (Array.isArray(v) && v.length > 0) v = v[0];
                    if (v !== undefined && v !== null && v !== "") return v;
                }

                if (typeof lastOutput === 'string' && lastOutput !== "") return lastOutput;
                return null;
            }

            // ═══════════════════════════════════════
            // ─── REMOTE SET NODE RESOLVERS ───
            // ═══════════════════════════════════════

            function resolveRemoteSetText(setNodeName) {
                debugListSetGetNodes(`searching text "${setNodeName}"`);

                const setNode = findSetNodeByName(setNodeName);
                if (!setNode) {
                    console.log(`[iz_chat] ✗ Remote Set "${setNodeName}" NOT FOUND`);
                    return null;
                }

                console.log(`[iz_chat] ✓ Remote Set "${setNodeName}" found (id:${setNode.id}, type:${setNode.type})`);

                const lastOut = extractFromLastOutput(setNode._lastOutput, 0);
                if (lastOut) {
                    console.log(`[iz_chat] ✓ Remote Set → _lastOutput ✓`);
                    return lastOut;
                }

                if (setNode.inputs) {
                    for (const inp of setNode.inputs) {
                        if (inp.link) {
                            const l = app.graph.links[inp.link];
                            if (l) {
                                const upstream = app.graph.getNodeById(l.origin_id);
                                const v = resolveValueFromNode(upstream, l.origin_slot, 0, 'STRING');
                                if (v) {
                                    console.log(`[iz_chat] ✓ Remote Set → resolved via input ✓`);
                                    return v;
                                }
                            }
                        }
                    }
                }

                if (setNode.widgets) {
                    const nameKeys = ["name", "set_name", "node_name", "setname", "nodename",
                                      "context_name", "contextname", "key", "id", "label",
                                      "get_name", "getname", "identifier", "bus_name", "busname"];
                    for (const w of setNode.widgets) {
                        if (w.value && typeof w.value === 'string' && w.value.length > 0) {
                            const wName = (w.name || "").toLowerCase();
                            if (!nameKeys.includes(wName)) {
                                return w.value;
                            }
                        }
                    }
                }

                console.log(`[iz_chat] ✗ Remote Set "${setNodeName}" → no value found`);
                return null;
            }

            function collectRemoteSetImages(setNodeName) {
                debugListSetGetNodes(`searching images "${setNodeName}"`);

                const setNode = findSetNodeByName(setNodeName);
                if (!setNode) {
                    console.log(`[iz_chat] ✗ Remote Set "${setNodeName}" for images NOT FOUND`);
                    return [];
                }

                console.log(`[iz_chat] ✓ Remote Set "${setNodeName}" for images found (id:${setNode.id})`);

                const urls = [];
                const visitedNodes = new Set();

                if (setNode._lastOutput) {
                    const lo = setNode._lastOutput;
                    if (lo.images && Array.isArray(lo.images)) {
                        for (const img of lo.images) {
                            let url = `/view?filename=${encodeURIComponent(img.filename)}`;
                            if (img.subfolder) url += `&subfolder=${encodeURIComponent(img.subfolder)}`;
                            if (img.type) url += `&type=${encodeURIComponent(img.type)}`;
                            url += `&t=${Date.now()}`;
                            urls.push(url);
                        }
                        if (urls.length > 0) return urls;
                    }
                    if (lo.gifs && Array.isArray(lo.gifs)) {
                        for (const img of lo.gifs) {
                            let url = `/view?filename=${encodeURIComponent(img.filename)}`;
                            if (img.subfolder) url += `&subfolder=${encodeURIComponent(img.subfolder)}`;
                            if (img.type) url += `&type=${encodeURIComponent(img.type)}`;
                            url += `&t=${Date.now()}`;
                            urls.push(url);
                        }
                        if (urls.length > 0) return urls;
                    }
                }

                if (setNode.inputs) {
                    for (const inp of setNode.inputs) {
                        if (inp.link) {
                            const l = app.graph.links[inp.link];
                            if (l) {
                                const upstream = app.graph.getNodeById(l.origin_id);
                                visitedNodes.delete(upstream.id);
                                collectImagesFromNode(upstream, urls, visitedNodes, 0);
                            }
                        }
                    }
                }

                return urls;
            }

            // ═══════════════════════════════════════
            // ─── VALUE RESOLUTION ───
            // ═══════════════════════════════════════

            function getWidgetValue(widgetName) {
                const input = node.inputs?.find(i => i.name === widgetName);

                if (input && input.link) {
                    const link = app.graph.links[input.link];
                    if (link) {
                        const src = app.graph.getNodeById(link.origin_id);
                        if (src) {
                            const result = resolveValueFromNode(src, link.origin_slot, 0, 'STRING');
                            if (result !== null && result !== undefined && result !== "") {
                                return result;
                            }
                        }
                    }
                }

                if (widgetName === "system_prompt") {
                    const remoteValue = resolveRemoteSetText(TEXT_SET_NODE_NAME);
                    if (remoteValue) return remoteValue;
                }

                const w = node.widgets?.find(w => w.name === widgetName);
                return w?.value;
            }

            function resolveValueFromNode(srcNode, slotIndex, depth, expectedType) {
                if (depth > 15 || !srcNode) return null;
                if (isNodeInactive(srcNode)) return null;

                if (isGetNode(srcNode)) {
                    const getName = getGetSetName(srcNode);
                    if (!getName) return null;

                    const setNode = findSetNodeByName(getName);
                    if (setNode) {
                        const lastOut = extractFromLastOutput(setNode._lastOutput, 0);
                        if (lastOut) return lastOut;

                        if (setNode.inputs) {
                            for (const inp of setNode.inputs) {
                                if (inp.link) {
                                    const l = app.graph.links[inp.link];
                                    if (l) {
                                        const upstream = app.graph.getNodeById(l.origin_id);
                                        const v = resolveValueFromNode(upstream, l.origin_slot, depth + 1, expectedType);
                                        if (v) return v;
                                    }
                                }
                            }
                        }
                    }
                    return null;
                }

                const lastOut = extractFromLastOutput(srcNode._lastOutput, slotIndex);
                if (lastOut) return lastOut;

                if (srcNode.widgets && srcNode.widgets[slotIndex]) {
                    const v = srcNode.widgets[slotIndex].value;
                    if (v !== undefined && v !== null && v !== "") return v;
                }

                if (srcNode.widgets) {
                    for (const w of srcNode.widgets) {
                        if (w.value && typeof w.value === 'string' && w.value.length > 0) {
                            const name = (w.name || "").toLowerCase();
                            if (name.includes('text') || name.includes('value') ||
                                name.includes('output') || name.includes('result') ||
                                name.includes('string') || name.includes('prompt')) {
                                return w.value;
                            }
                        }
                    }
                }

                if (isAnySwitchNode(srcNode.type)) {
                    if (srcNode.inputs) {
                        for (const inp of srcNode.inputs) {
                            if (!inp.link) continue;
                            const l = app.graph.links[inp.link];
                            if (!l) continue;

                            const upstream = app.graph.getNodeById(l.origin_id);
                            if (!upstream) continue;
                            if (isNodeInactive(upstream)) continue;

                            const v = resolveValueFromNode(upstream, l.origin_slot, depth + 1, expectedType);
                            if (v) return v;
                        }
                    }
                    return null;
                }

                if (isRouterNode(srcNode.type)) {
                    if (srcNode.inputs) {
                        for (const inp of srcNode.inputs) {
                            if (inp.link) {
                                const l = app.graph.links[inp.link];
                                if (l) {
                                    const upstream = app.graph.getNodeById(l.origin_id);
                                    const v = resolveValueFromNode(upstream, l.origin_slot, depth + 1, expectedType);
                                    if (v) return v;
                                }
                            }
                        }
                    }
                    return null;
                }

                if (srcNode.inputs && srcNode.inputs.length > 0) {
                    const parts = [];
                    for (const inp of srcNode.inputs) {
                        const inpType = (inp.type || "").toUpperCase();
                        if (inpType !== "STRING" && inpType !== "TEXT") continue;

                        if (inp.link) {
                            const l = app.graph.links[inp.link];
                            if (l) {
                                const upstream = app.graph.getNodeById(l.origin_id);
                                const v = resolveValueFromNode(upstream, l.origin_slot, depth + 1, 'STRING');
                                if (v && typeof v === 'string') parts.push(v);
                            }
                        }
                    }
                    if (parts.length > 0) return parts.join(" ");
                }

                return null;
            }

            // ═══════════════════════════════════════
            // ─── IMAGE COLLECTION ───
            // ═══════════════════════════════════════

            function collectImagesFromNode(srcNode, urls, visitedNodes, depth) {
                if (!srcNode || visitedNodes.has(srcNode.id)) return;
                if (depth > 15) return;
                visitedNodes.add(srcNode.id);

                const nodeType = srcNode.type || "?";
                if (isNodeInactive(srcNode)) return;

                if (isGetNode(srcNode)) {
                    const getName = getGetSetName(srcNode);
                    if (!getName) return;

                    const setNode = findSetNodeByName(getName);
                    if (setNode) {
                        visitedNodes.delete(setNode.id);
                        collectImagesFromNode(setNode, urls, visitedNodes, depth + 1);

                        if (setNode.inputs) {
                            for (const inp of setNode.inputs) {
                                if (inp.link) {
                                    const l = app.graph.links[inp.link];
                                    if (l) {
                                        const upstream = app.graph.getNodeById(l.origin_id);
                                        visitedNodes.delete(upstream.id);
                                        collectImagesFromNode(upstream, urls, visitedNodes, depth + 1);
                                    }
                                }
                            }
                        }
                    }
                    return;
                }

                if (nodeType === "LoadImage" || nodeType === "LoadImageMask") {
                    const imgWidget = srcNode.widgets?.find(w => w.name === "image");
                    const subfolderWidget = srcNode.widgets?.find(w => w.name === "subfolder");
                    const subfolder = subfolderWidget?.value || "";
                    if (imgWidget && imgWidget.value) {
                        const filename = imgWidget.value;
                        let url = `/view?filename=${encodeURIComponent(filename)}&type=input`;
                        if (subfolder) url += `&subfolder=${encodeURIComponent(subfolder)}`;
                        url += `&t=${Date.now()}`;
                        urls.push(url);
                    }
                    return;
                }

                if (isAnySwitchNode(nodeType)) {
                    if (srcNode.inputs) {
                        for (const inp of srcNode.inputs) {
                            if (!inp.link) continue;
                            const l = app.graph.links[inp.link];
                            if (!l) continue;

                            const upstream = app.graph.getNodeById(l.origin_id);
                            if (!upstream) continue;
                            if (isNodeInactive(upstream)) continue;

                            const beforeCount = urls.length;
                            visitedNodes.delete(upstream.id);
                            collectImagesFromNode(upstream, urls, visitedNodes, depth + 1);

                            if (urls.length > beforeCount) return;
                        }
                    }
                    return;
                }

                if (isRouterNode(nodeType)) {
                    if (srcNode.inputs) {
                        for (const inp of srcNode.inputs) {
                            if (inp.link) {
                                const l = app.graph.links[inp.link];
                                if (l) {
                                    const upstream = app.graph.getNodeById(l.origin_id);
                                    visitedNodes.delete(upstream.id);
                                    collectImagesFromNode(upstream, urls, visitedNodes, depth + 1);
                                }
                            }
                        }
                    }
                    return;
                }

                const lastOut = srcNode._lastOutput;
                if (lastOut) {
                    if (lastOut.images && Array.isArray(lastOut.images)) {
                        for (const img of lastOut.images) {
                            let url = `/view?filename=${encodeURIComponent(img.filename)}`;
                            if (img.subfolder) url += `&subfolder=${encodeURIComponent(img.subfolder)}`;
                            if (img.type) url += `&type=${encodeURIComponent(img.type)}`;
                            url += `&t=${Date.now()}`;
                            urls.push(url);
                        }
                        if (urls.length > 0) return;
                    }
                    if (lastOut.gifs && Array.isArray(lastOut.gifs)) {
                        for (const img of lastOut.gifs) {
                            let url = `/view?filename=${encodeURIComponent(img.filename)}`;
                            if (img.subfolder) url += `&subfolder=${encodeURIComponent(img.subfolder)}`;
                            if (img.type) url += `&type=${encodeURIComponent(img.type)}`;
                            url += `&t=${Date.now()}`;
                            urls.push(url);
                        }
                        if (urls.length > 0) return;
                    }
                }

                if (srcNode.inputs) {
                    for (const inp of srcNode.inputs) {
                        if (inp.link && (inp.type === "IMAGE" || (inp.name || "").toLowerCase().includes("image"))) {
                            const l = app.graph.links[inp.link];
                            if (l) {
                                const upstream = app.graph.getNodeById(l.origin_id);
                                visitedNodes.delete(upstream.id);
                                collectImagesFromNode(upstream, urls, visitedNodes, depth + 1);
                            }
                        }
                    }
                }
            }

            function getImageUrls() {
                const urls = [];
                const visitedNodes = new Set();

                const input = node.inputs?.find(i => i.name === "image");
                if (input && input.link) {
                    const link = app.graph.links[input.link];
                    if (link) {
                        const srcNode = app.graph.getNodeById(link.origin_id);
                        collectImagesFromNode(srcNode, urls, visitedNodes, 0);
                        if (urls.length > 0) return urls;
                    }
                }

                const remoteUrls = collectRemoteSetImages(IMAGE_SET_NODE_NAME);
                if (remoteUrls.length > 0) return remoteUrls;

                return null;
            }

            function getTokenLimitFromCfg() {
                const cfgInput = node.inputs?.find(i => i.name === "cfg");
                if (cfgInput && cfgInput.link) {
                    const link = app.graph.links[cfgInput.link];
                    if (link) {
                        const cfgNode = app.graph.getNodeById(link.origin_id);
                        if (cfgNode) {
                            const limitWidget = cfgNode.widgets?.find(w => w.name === "token_limit");
                            if (limitWidget && limitWidget.value !== undefined) return parseInt(limitWidget.value) || 4096;
                        }
                    }
                }
                return 4096;
            }

            function readCfgParams() {
                const params = { max_image_mp: 1.0, max_length: 512, seed: 777, token_limit: 4096 };
                const cfgInput = node.inputs?.find(i => i.name === "cfg");
                if (cfgInput && cfgInput.link) {
                    const link = app.graph.links[cfgInput.link];
                    if (link) {
                        const cfgNode = app.graph.getNodeById(link.origin_id);
                        if (cfgNode) {
                            const mpWidget = cfgNode.widgets?.find(w => w.name === "max_image_mp");
                            if (mpWidget && mpWidget.value !== undefined) params.max_image_mp = parseFloat(mpWidget.value);
                            const mlWidget = cfgNode.widgets?.find(w => w.name === "max_length");
                            if (mlWidget && mlWidget.value !== undefined) params.max_length = parseInt(mlWidget.value);
                            const seedWidget = cfgNode.widgets?.find(w => w.name === "seed");
                            if (seedWidget && seedWidget.value !== undefined) params.seed = parseInt(seedWidget.value);
                            const limitWidget = cfgNode.widgets?.find(w => w.name === "token_limit");
                            if (limitWidget && limitWidget.value !== undefined) params.token_limit = parseInt(limitWidget.value);
                        }
                    }
                }
                return params;
            }

            function estimateTextTokens(text) { return text ? Math.ceil(text.length / 3.5) : 0; }
            function estimateImageTokens(w, h) { return (w && h) ? Math.ceil((w * h) / 784) : 0; }

            function calculateTokenUsage() {
                let total = 0;
                total += estimateTextTokens(getWidgetValue("system_prompt") || "");
                for (const msg of chatHistory) { total += estimateTextTokens(msg.content); total += 4; }
                for (const size of loadedImageSizes) total += estimateImageTokens(size.width, size.height);
                return total;
            }

            async function updateImageSizes() {
                const urls = getImageUrls();
                if (!urls || urls.length === 0) { loadedImageSizes = []; return; }
                const sizes = [];
                for (const url of urls) {
                    try {
                        const resp = await fetch(url, { cache: 'no-store' });
                        if (!resp.ok) continue;
                        const contentType = resp.headers.get('content-type') || '';
                        if (!contentType.startsWith('image/')) continue;
                        const blob = await resp.blob();
                        const imgBitmap = await createImageBitmap(blob);
                        sizes.push({ width: imgBitmap.width, height: imgBitmap.height });
                        imgBitmap.close();
                    } catch (e) {}
                }
                loadedImageSizes = sizes;
            }

            function updateIdleProgress() {
                if (isGenerating) return;
                const currentTokenLimit = getTokenLimitFromCfg();
                const used = calculateTokenUsage();
                const pct = Math.min((used / currentTokenLimit) * 100, 100);
                progressFill.style.width = `${pct}%`;
                if (used > currentTokenLimit) {
                    progressFill.classList.add("over-limit");
                    progressFill.classList.remove("generating");
                    progressTokens.textContent = `${used}/${currentTokenLimit} tokens ⚠`;
                    progressTokens.classList.add("danger");
                } else {
                    progressFill.classList.remove("over-limit");
                    progressFill.classList.remove("generating");
                    progressTokens.textContent = `${used}/${currentTokenLimit} tokens`;
                    progressTokens.classList.remove("danger");
                }
                progressStage.textContent = "";
                progressSpeed.textContent = "";
            }

            function hashContext(messages) {
                const str = JSON.stringify(messages.map(m => ({ r: m.role, c: m.content })));
                let hash = 0;
                for (let i = 0; i < str.length; i++) { hash = ((hash << 5) - hash) + str.charCodeAt(i); hash |= 0; }
                return hash.toString(16);
            }

            function setStatus(text, color) { status.textContent = text; status.style.color = color || "#bbb"; }

            function copyToClipboard(text) {
                if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
                const ta = document.createElement("textarea");
                ta.value = text; ta.style.position = "fixed"; ta.style.left = "-9999px";
                document.body.appendChild(ta); ta.select(); document.execCommand("copy");
                document.body.removeChild(ta); return Promise.resolve();
            }

            async function imagesToBase64() {
                const urls = getImageUrls();
                if (!urls || urls.length === 0) { imgStatus.textContent = ""; loadedImageSizes = []; return null; }
                imgStatus.textContent = `loading ${urls.length} image(s)...`;
                imgStatus.style.color = "#8abaff";
                const b64List = []; const sizes = [];
                let successCount = 0; let failCount = 0;
                for (const url of urls) {
                    try {
                        const resp = await fetch(url, { cache: 'no-store' });
                        if (!resp.ok) { failCount++; continue; }
                        const contentType = resp.headers.get('content-type') || '';
                        if (!contentType.startsWith('image/')) { failCount++; continue; }
                        const blob = await resp.blob();
                        try {
                            const imgBitmap = await createImageBitmap(blob);
                            sizes.push({ width: imgBitmap.width, height: imgBitmap.height });
                            imgBitmap.close();
                        } catch (e) {}
                        const b64 = await new Promise((resolve, reject) => {
                            const reader = new FileReader();
                            reader.onloadend = () => resolve(reader.result);
                            reader.onerror = reject;
                            reader.readAsDataURL(blob);
                        });
                        b64List.push(b64); successCount++;
                    } catch (e) { failCount++; }
                }
                loadedImageSizes = sizes;
                if (successCount === 0) { imgStatus.textContent = `failed to load images`; imgStatus.style.color = "#f66"; return null; }
                else if (failCount > 0) { imgStatus.textContent = `${successCount}/${urls.length} loaded`; imgStatus.style.color = "#fa6"; }
                else { imgStatus.textContent = `${successCount} image(s)`; imgStatus.style.color = "#8f8"; }
                if (b64List.length === 0) return null;
                return b64List;
            }

            function startProgressPolling() {
                stopProgressPolling();
                progressFill.className = "iz-progress-fill generating";
                progressTokens.classList.remove("danger");
                progressInterval = setInterval(async () => {
                    try {
                        const resp = await fetch("/iz_chat/progress");
                        const d = await resp.json();
                        if (d.active) {
                            progressStage.textContent = d.stage || "";
                            if (d.tokens_total > 0) {
                                progressTokens.textContent = `${d.tokens_current}/${d.tokens_total} tokens`;
                                progressFill.style.width = `${Math.min((d.tokens_current / d.tokens_total) * 100, 100)}%`;
                            }
                            let speedText = "";
                            if (d.speed > 0) speedText = `${d.speed.toFixed(1)} tok/s`;
                            if (d.elapsed > 0) speedText += ` · ${d.elapsed.toFixed(1)}s`;
                            progressSpeed.textContent = speedText;
                        }
                    } catch (e) {}
                }, 200);
            }

            function stopProgressPolling() {
                if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
            }

            function updateGenerateButton() {
                if (chatHistory.length === 0) { generateBtn.classList.remove("visible"); return; }
                const last = chatHistory[chatHistory.length - 1];
                if (last.role === "user") generateBtn.classList.add("visible");
                else generateBtn.classList.remove("visible");
            }

            function buildMessageEl(msg, index) {
                const el = document.createElement("div");
                const rc = msg.role === "user" ? "iz-msg-user" : msg.role === "assistant" ? "iz-msg-assistant" : "iz-msg-system";
                el.className = `iz-msg ${rc}`;

                if (editingIndex === index) {
                    const editArea = document.createElement("textarea");
                    editArea.className = "iz-edit-area";
                    editArea.value = msg.content;
                    editArea.rows = Math.max(3, msg.content.split("\n").length);
                    el.appendChild(editArea);
                    const ctrls = document.createElement("div");
                    ctrls.className = "iz-edit-controls";
                    const saveB = document.createElement("button");
                    saveB.className = "iz-edit-save"; saveB.textContent = "save";
                    saveB.onclick = () => { chatHistory[index].content = editArea.value; editingIndex = -1; updateChatDisplay(); syncChatWidget(); updateIdleProgress(); };
                    const cancelB = document.createElement("button");
                    cancelB.className = "iz-edit-cancel"; cancelB.textContent = "cancel";
                    cancelB.onclick = () => { editingIndex = -1; updateChatDisplay(); };
                    ctrls.append(saveB, cancelB); el.appendChild(ctrls);
                    setTimeout(() => editArea.focus(), 50);
                    return el;
                }

                const label = document.createElement("span");
                label.className = "iz-msg-label";
                label.textContent = msg.role === "user" ? "you" : msg.role === "assistant" ? "assistant" : "system";
                el.appendChild(label);

                const textDiv = document.createElement("div");
                textDiv.textContent = msg.content;
                el.appendChild(textDiv);

                if (msg.role === "assistant" && msg.seed) {
                    const seedRow = document.createElement("div");
                    seedRow.className = "iz-msg-seed-row";
                    const seedDiv = document.createElement("span");
                    seedDiv.className = "iz-msg-seed";
                    seedDiv.textContent = `seed: ${msg.seed}`;
                    seedRow.appendChild(seedDiv);
                    const copyB = document.createElement("button");
                    copyB.className = "iz-msg-copy"; copyB.textContent = "⧉"; copyB.title = "Copy text";
                    copyB.onclick = (e) => {
                        e.stopPropagation();
                        copyToClipboard(msg.content).then(() => {
                            setStatus("copied", "#8f8");
                            setTimeout(() => { if (!isWorkflowRunning && !isGenerating) setStatus("ready to chat", "#bbb"); }, 1500);
                        });
                    };
                    seedRow.appendChild(copyB); el.appendChild(seedRow);
                }

                const controls = document.createElement("div");
                controls.className = "iz-msg-controls";

                if (msg.role === "assistant") {
                    const regenB = document.createElement("button");
                    regenB.className = "iz-msg-btn iz-msg-btn-regen"; regenB.textContent = "⟳"; regenB.title = "Regenerate";
                    regenB.onclick = (e) => { e.stopPropagation(); regenerateMessage(index); };
                    regenButtons.push(regenB); controls.appendChild(regenB);

                    const anchorB = document.createElement("button");
                    anchorB.className = "iz-msg-btn iz-msg-btn-anchor"; anchorB.textContent = "⚓";
                    anchorB.title = "Start new chat from this message";
                    anchorB.onclick = (e) => {
                        e.stopPropagation();
                        if (confirm("Start new chat from this message?\nAll history will be deleted.")) {
                            chatHistory = [{ ...chatHistory[index] }]; editingIndex = -1;
                            updateChatDisplay(); syncChatWidget(); updateIdleProgress();
                            setStatus("chat started from this message", "#8f8");
                            setTimeout(() => { if (!isWorkflowRunning && !isGenerating) setStatus("ready to chat", "#bbb"); }, 2000);
                        }
                    };
                    controls.appendChild(anchorB);
                }

                const editB = document.createElement("button");
                editB.className = "iz-msg-btn"; editB.textContent = "✎"; editB.title = "Edit";
                editB.onclick = (e) => { e.stopPropagation(); editingIndex = index; updateChatDisplay(); };
                controls.appendChild(editB);

                const delB = document.createElement("button");
                delB.className = "iz-msg-btn iz-msg-btn-del"; delB.textContent = "✕"; delB.title = "Delete";
                delB.onclick = (e) => {
                    e.stopPropagation(); chatHistory.splice(index, 1);
                    updateChatDisplay(); syncChatWidget(); updateIdleProgress();
                    setStatus("deleted", "#f88");
                    setTimeout(() => { if (!isWorkflowRunning && !isGenerating) setStatus("ready to chat", "#bbb"); }, 2000);
                };
                controls.appendChild(delB);

                el.appendChild(controls);
                return el;
            }

            function updateChatDisplay() {
                chatContainer.innerHTML = "";
                regenButtons = [];
                if (chatHistory.length === 0) {
                    chatContainer.innerHTML = '<div class="iz-chat-empty">chat is empty</div>';
                } else {
                    chatHistory.forEach((msg, i) => chatContainer.appendChild(buildMessageEl(msg, i)));
                    chatContainer.scrollTop = chatContainer.scrollHeight;
                }
                updateGenerateButton();
                updateButtonsState();
            }

            function syncChatWidget() { if (chatHistoryWidget) chatHistoryWidget.value = JSON.stringify(chatHistory); }

            async function checkModelStatus() {
                try { const resp = await fetch("/iz_chat/status"); const data = await resp.json(); return data.model_loaded; }
                catch { return false; }
            }

            async function runGeneration(url, body, onSuccess) {
                const modelReady = await checkModelStatus();
                if (!modelReady) { setStatus("⚠ model not loaded — run workflow", "#fa6"); return; }
                isGenerating = true; updateButtonsState();
                setStatus("generating...", "#6af"); startProgressPolling();
                try {
                    const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
                    const result = await resp.json();
                    if (result.success) onSuccess(result);
                    else setStatus(`✕ ${result.message}`, "#f66");
                } catch (err) { console.error("[iz_chat]", err); setStatus(`✕ ${err.message}`, "#f66"); }
                isGenerating = false; updateButtonsState();
                stopProgressPolling(); updateIdleProgress();
                const workflowActive = await isAnyWorkflowActive();
                if (workflowActive) {
                    isWorkflowRunning = true; updateButtonsState();
                    setStatus("workflow running... you can type, send after finish", "#fa6");
                } else {
                    isWorkflowRunning = false; updateButtonsState();
                    setStatus("ready to chat", "#bbb");
                }
            }

            async function buildRequestBody(extraData = {}) {
                const body = { system_prompt: getWidgetValue("system_prompt") || "You are a helpful assistant.", ...extraData };
                const cfgParams = readCfgParams();
                body.max_image_mp = cfgParams.max_image_mp;
                body.max_length = cfgParams.max_length;
                body.seed = cfgParams.seed;
                const imageB64 = await imagesToBase64();
                if (imageB64) body.image_b64 = imageB64;
                return body;
            }

            async function sendMessage() {
                const message = inputField.value.trim();
                if (!message || isGenerating) return;
                if (isWorkflowRunning || await isAnyWorkflowActive()) {
                    isWorkflowRunning = true; updateButtonsState();
                    setStatus("⏳ wait for workflow to finish, then send", "#fa6"); return;
                }
                if (editingIndex >= 0) { editingIndex = -1; updateChatDisplay(); }
                chatHistory.push({ role: "user", content: message });
                updateChatDisplay(); syncChatWidget(); updateIdleProgress();
                inputField.value = ""; autoResizeInput();
                const body = await buildRequestBody({ chat_history: chatHistory });
                await runGeneration("/iz_chat/generate", body, (result) => {
                    const last = result.chat_history[result.chat_history.length - 1];
                    if (last && last.role === "assistant") { last.seed = result.seed; last.context_hash = hashContext(result.chat_history.slice(0, -1)); }
                    chatHistory = result.chat_history;
                    updateChatDisplay(); syncChatWidget(); updateIdleProgress();
                });
            }

            async function generateResponse() {
                if (isGenerating || chatHistory.length === 0) return;
                if (chatHistory[chatHistory.length - 1].role !== "user") return;
                if (isWorkflowRunning || await isAnyWorkflowActive()) {
                    isWorkflowRunning = true; updateButtonsState();
                    setStatus("⏳ wait for workflow to finish, then generate", "#fa6"); return;
                }
                const body = await buildRequestBody({ chat_history: chatHistory });
                await runGeneration("/iz_chat/generate", body, (result) => {
                    const last = result.chat_history[result.chat_history.length - 1];
                    if (last && last.role === "assistant") { last.seed = result.seed; last.context_hash = hashContext(result.chat_history.slice(0, -1)); }
                    chatHistory = result.chat_history;
                    updateChatDisplay(); syncChatWidget(); updateIdleProgress();
                });
            }

            async function regenerateMessage(index) {
                if (isGenerating) return;
                if (isWorkflowRunning || await isAnyWorkflowActive()) {
                    isWorkflowRunning = true; updateButtonsState();
                    setStatus("⏳ wait for workflow to finish, then regenerate", "#fa6"); return;
                }
                const msg = chatHistory[index];
                if (!msg || msg.role !== "assistant") return;
                const contextBefore = chatHistory.slice(0, index);
                const currentHash = hashContext(contextBefore);
                const useNewSeed = msg.context_hash && msg.context_hash === currentHash;
                const body = await buildRequestBody({ chat_history: contextBefore, use_new_seed: useNewSeed });
                await runGeneration("/iz_chat/regenerate", body, (result) => {
                    chatHistory[index] = { role: "assistant", content: result.response, seed: result.seed, context_hash: currentHash };
                    chatHistory = chatHistory.slice(0, index + 1);
                    updateChatDisplay(); syncChatWidget(); updateIdleProgress();
                });
            }

            sendBtn.onclick = sendMessage;
            generateBtn.onclick = generateResponse;
            inputField.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } };
            clearBtn.onclick = () => {
                if (chatHistory.length === 0) return;
                if (!confirm("Clear chat?")) return;
                chatHistory = []; editingIndex = -1; loadedImageSizes = [];
                updateChatDisplay(); syncChatWidget(); updateIdleProgress();
                setStatus("chat cleared", "#f88");
                setTimeout(() => { if (!isWorkflowRunning && !isGenerating) setStatus("ready to chat", "#bbb"); }, 2000);
            };

            const widget = node.addDOMWidget("chat_controls", "Chat", container);
            widget.computeSize = () => [currentWidth, 540];
            const onRemoved = node.onRemoved;
            node.onRemoved = function () { chatHistory = []; editingIndex = -1; loadedImageSizes = []; regenButtons = []; stopProgressPolling(); onRemoved?.apply(this, arguments); };

            setTimeout(() => {
                try { const saved = chatHistoryWidget?.value; if (saved && saved !== "[]") chatHistory = JSON.parse(saved); }
                catch (e) { console.error("[iz_chat] Error loading history:", e); }
                updateChatDisplay(); checkModelStatus(); autoResizeInput(); updateButtonsState();

                setTimeout(() => debugListSetGetNodes("startup"), 1000);

                (async () => { await updateImageSizes(); updateIdleProgress(); })();
                setTimeout(() => {
                    const urls = getImageUrls();
                    if (urls) { imgStatus.textContent = `${urls.length} image(s) connected`; imgStatus.style.color = "#8abaff"; }
                }, 500);
            }, 200);

            setInterval(async () => {
                if (!isGenerating) {
                    const urls = getImageUrls();
                    if (urls) {
                        const curText = imgStatus.textContent;
                        if (!curText.includes("loading") && !curText.includes("failed")) {
                            imgStatus.textContent = `${urls.length} image(s)`; imgStatus.style.color = "#8f8";
                        }
                    } else { imgStatus.textContent = ""; }
                    await updateImageSizes(); updateIdleProgress();
                }
            }, 3000);

            setInterval(async () => {
                try {
                    const workflowActive = await isAnyWorkflowActive();
                    if (workflowActive && !isWorkflowRunning) {
                        isWorkflowRunning = true; updateButtonsState();
                        if (!isGenerating) setStatus("workflow running... you can type, send after finish", "#fa6");
                    } else if (!workflowActive && isWorkflowRunning) {
                        isWorkflowRunning = false; updateButtonsState();
                        if (!isGenerating) setStatus("ready to chat", "#bbb");
                    }
                } catch (e) {}
            }, 500);

            console.log("[iz_chat] widget created");
        };
    }
});
