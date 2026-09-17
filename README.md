# iz_chat
LLM chat node for ComfyUI — chat with Vision-Language models directly in the node UI, no workflow execution needed for generation.

### Installation:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/IZmake/iz_chat.git
```

### First Run and How It Works
- If your model works with the “Generate Text” node from ComfyUI, it will most likely work with the “iz chat” node as well.
- - Only local models
- Run workflow to link model to iz chat
- - Load CLIP -> iz chat cfg -> iz chat ->  Preview as Text or another node that can accept text
- You can interact with LLM without restarting workflow
- - Without restarting the workflow, you can connect nodes containing text or image(s)
- Rerun the workflow to pass the latest LLM response to the text node
  
https://github.com/user-attachments/assets/29a637cb-0204-4e04-b7be-de1acc57b690

### Works with Any Switch and Set Node nodes (if needed)
- For Set node, specify the following values:
```bash
text_to_iz_chat
```
- and
```bash
img_to_iz_chat
```
- Get node is not required
- Priority:
- - Text node to system prompt input > Set node > system prompt line
- - image(s) node to image(s) input > Set node

https://github.com/user-attachments/assets/3ec06dde-c748-43f9-ae30-255ce5863923

https://github.com/user-attachments/assets/eb25720c-34e8-4247-94ef-f91e118a6780

### Can accept more than one image
https://github.com/user-attachments/assets/f141fc79-c3df-49ed-9d7a-afefbe343677

### What else can you do? 
- When you save the workflow, the chat history is saved, so you don't have to regenerate the same response.
- You can edit and delete user input
- You can edit and delete LLM messages
- You can regenerate LLM messages with a random seed
- You can quickly clear the chat by clicking the “Clear Chat” button.
- You can make any LLM message the first one, thereby clearing the chat but continuing to edit the prompt.

<img width="757" height="482" alt="image" src="https://github.com/user-attachments/assets/bf1e45b5-f8f0-4164-b7c5-710f9c23258e" />



### What might this be useful for?
- Chatting with LLM for fun.
- Promt Enhancer
- - You can use the chat to change any details you didn't like after using Prompt Enhancer
    
 ### P.S.
- The nodes were created using Qwen 3.8-Max
- You can optimize and improve the code—I'm all for it.
- I'm sorry if any of my points aren't clear. I'm not a native English speaker. I used a translator.
