const MAX_ATTACHMENT_BYTES = 60 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);
const insertionRanges = new WeakMap();

function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function attachmentResult(result, file) {
    const attachment = result?.attachment;
    let url;
    try { url = new URL(attachment?.url); } catch { /* Report the invalid response below. */ }
    if (!url || url.protocol !== "https:" || url.username || url.password ||
        !(url.hostname === "dev.azure.com" || url.hostname.endsWith(".visualstudio.com")) ||
        !/\/_apis\/wit\/attachments\/[^/]+$/i.test(url.pathname)) {
        throw new Error("The upload did not return a valid Azure DevOps attachment link.");
    }
    return { ...attachment, fileName: attachment.fileName || file.name };
}

export function attachmentMarkdown(attachment, file) {
    const name = String(attachment.fileName || file.name).replace(/[\r\n]/g, " ").replace(/[\\\[\]]/g, "\\$&");
    const url = attachment.url.replace(/[<>\s]/g, character => encodeURIComponent(character));
    return `${IMAGE_TYPES.has(file.type) ? "!" : ""}[${name}](<${url}>)`;
}

function attachmentNode(doc, attachment, file, { format, imageUrl }) {
    const isImage = IMAGE_TYPES.has(file.type);
    const node = doc.createElement(isImage ? "img" : "a");
    if (isImage) {
        node.alt = attachment.fileName;
        node.src = format === "comment" ? imageUrl?.(attachment.url) || attachment.url : attachment.url;
    } else {
        node.href = attachment.url;
        node.textContent = attachment.fileName;
    }
    if (format !== "comment") return node;
    const wrapper = doc.createElement("span");
    wrapper.className = "comment-attachment";
    wrapper.setAttribute("contenteditable", "false");
    wrapper.dataset.attachmentReference = attachmentMarkdown(attachment, file);
    wrapper.append(node);
    return wrapper;
}

export function restoreAttachmentPreviews(body, imageUrl) {
    for (const text of [...body.childNodes].filter(node => node.nodeType === 3)) {
        const matches = [...text.data.matchAll(/!\[((?:\\.|[^\]\\\n])*)\]\(<(https:\/\/[^>\s]+)>\)/g)];
        if (!matches.length) continue;
        const fragment = body.ownerDocument.createDocumentFragment();
        let offset = 0;
        for (const match of matches) {
            fragment.append(text.data.slice(offset, match.index));
            const file = { name: match[1].replace(/\\([\\\[\]])/g, "$1"), type: "image/png" };
            try {
                const attachment = attachmentResult({ attachment: { url: match[2], fileName: file.name } }, file);
                const node = attachmentNode(body.ownerDocument, attachment, file, { format: "comment", imageUrl });
                node.dataset.attachmentReference = match[0];
                fragment.append(node);
            } catch {
                fragment.append(match[0]);
            }
            offset = match.index + match[0].length;
        }
        fragment.append(text.data.slice(offset));
        text.replaceWith(fragment);
    }
}

// A live DOM range follows typing during an upload. Textareas need an equivalent
// bookmark because replacing their value does not move a saved character offset.
export function captureAttachmentInsertion(target, { format, imageUrl, preserveDetached = false } = {}) {
    const doc = target.ownerDocument;
    const wasConnected = target.isConnected;
    let position = target.selectionStart || 0;
    let previous = target.value;
    const track = event => {
        const current = target.value;
        let prefix = 0;
        while (prefix < previous.length && prefix < current.length && previous[prefix] === current[prefix]) prefix += 1;
        let suffix = 0;
        while (suffix < previous.length - prefix && suffix < current.length - prefix && previous.at(-1 - suffix) === current.at(-1 - suffix)) suffix += 1;
        if (prefix < position || (prefix === position && event.attachmentInsertion)) {
            position = position <= previous.length - suffix
                ? current.length - suffix
                : position + current.length - previous.length;
        }
        position = Math.min(position, current.length);
        previous = current;
    };
    const selection = doc.getSelection?.();
    const range = selection?.rangeCount && target.contains(selection.getRangeAt(0).commonAncestorContainer)
        ? selection.getRangeAt(0).cloneRange()
        : doc.createRange();
    if (!target.contains(range.commonAncestorContainer)) {
        range.selectNodeContents(target);
        range.collapse(false);
    } else range.collapse(true);
    const ranges = insertionRanges.get(target) || new Set();
    if (format === "markdown") target.addEventListener("input", track);
    else {
        ranges.add(range);
        insertionRanges.set(target, ranges);
    }
    const release = () => {
        target.removeEventListener("input", track);
        ranges.delete(range);
    };
    return {
        release,
        insert(attachment, file) {
            release();
            if (wasConnected && !target.isConnected && !preserveDetached) return;
            if (format === "markdown") {
                const snippet = attachmentMarkdown(attachment, file);
                target.value = target.value.slice(0, position) + snippet + target.value.slice(position);
                if (doc.activeElement === target) target.setSelectionRange(position + snippet.length, position + snippet.length);
            } else {
                const inserted = attachmentNode(doc, attachment, file, { format, imageUrl });
                if (!target.contains(range.commonAncestorContainer)) {
                    range.selectNodeContents(target);
                    range.collapse(false);
                }
                const followers = [...ranges].filter(other => range.compareBoundaryPoints(0, other) === 0);
                range.insertNode(inserted);
                range.setStartAfter(inserted);
                range.collapse(true);
                for (const other of followers) {
                    other.setStartAfter(inserted);
                    other.collapse(true);
                }
                if (doc.activeElement === target) {
                    selection.removeAllRanges();
                    selection.addRange(range);
                }
            }
            const event = new doc.defaultView.Event("input", { bubbles: true });
            event.attachmentInsertion = true;
            target.dispatchEvent(event);
        },
    };
}

export function createAttachmentUpload({ onUploadAttachment, captureInsertion, label = "Attach files" }) {
    const host = element("div", "attachment-upload");
    const input = element("input", "attachment-file-input");
    input.type = "file";
    input.multiple = true;
    input.hidden = true;
    input.setAttribute("aria-label", label);
    const button = element("button", "primer-button secondary attachment-choose", label);
    button.type = "button";
    const hint = element("span", "attachment-hint", "Drop files here · up to 60 MiB each. Files attach immediately.");
    const status = element("div", "attachment-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    host.append(button, input, hint, status);
    let pending = 0;
    let queue = Promise.resolve();

    const uploadFiles = files => {
        const uploads = [...files].map(file => {
            const row = element("div", "attachment-upload-result");
            const message = element("span", "", `Waiting to upload ${file.name}…`);
            row.append(message);
            status.append(row);
            let bookmark;
            try {
                if (!file.name || !Number.isFinite(file.size) || file.size > MAX_ATTACHMENT_BYTES) {
                    throw new Error(file.size > MAX_ATTACHMENT_BYTES ? `${file.name} is larger than 60 MiB. Choose a smaller file.` : "Choose a file with a name.");
                }
                bookmark = captureInsertion?.();
            } catch (error) {
                message.textContent = error.message;
                row.setAttribute("role", "alert");
                row.classList.add("error");
                return Promise.resolve();
            }
            pending += 1;
            host.setAttribute("aria-busy", "true");
            const run = async () => {
                const progress = element("progress", "attachment-progress");
                progress.setAttribute("aria-label", `Uploading ${file.name}`);
                message.textContent = `Uploading ${file.name}…`;
                row.prepend(progress);
                try {
                    const attachment = attachmentResult(await onUploadAttachment(file), file);
                    bookmark?.insert(attachment, file);
                    const link = element("a", "attachment-result-link", attachment.fileName);
                    link.href = attachment.url;
                    link.target = "_blank";
                    link.rel = "noopener noreferrer";
                    message.replaceChildren("Attached ", link);
                } catch (error) {
                    message.textContent = `${file.name}: ${error?.message || "Upload failed. Try again."}`;
                    row.setAttribute("role", "alert");
                    row.classList.add("error");
                } finally {
                    bookmark?.release();
                    progress.remove();
                    pending -= 1;
                    host.setAttribute("aria-busy", String(pending > 0));
                }
            };
            queue = queue.then(run);
            return queue;
        });
        return Promise.all(uploads);
    };
    button.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
        void uploadFiles(input.files || []);
        input.value = "";
    });
    host.addEventListener("dragover", event => {
        event.preventDefault();
        host.classList.add("is-dragging");
    });
    host.addEventListener("dragleave", () => host.classList.remove("is-dragging"));
    host.addEventListener("drop", event => {
        event.preventDefault();
        host.classList.remove("is-dragging");
        void uploadFiles(event.dataTransfer?.files || []);
    });
    return {
        host,
        uploadFiles,
        isUploading: () => pending > 0,
        handlePaste(event) {
            const clipboard = event.clipboardData;
            const files = [...(clipboard?.files || [])];
            if (!files.length) {
                for (const item of clipboard?.items || []) {
                    if (item.kind === "file") {
                        const file = item.getAsFile();
                        if (file) files.push(file);
                    }
                }
            }
            const images = files.filter(file => file.type.startsWith("image/"));
            if (!images.length) return false;
            event.preventDefault();
            void uploadFiles(images);
            return true;
        },
    };
}
