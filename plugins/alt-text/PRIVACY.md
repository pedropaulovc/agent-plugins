# Privacy — alt-text

## What this plugin does

This plugin supplies prompt instructions for writing accessibility-focused alt text. It does not include an image-upload service, social-network integration, or automatic publishing action.

## Information processed

When you use the skill in Claude Code, the image and any accompanying prompt, post text, platform choice, and the generated response are part of the normal Claude conversation. Anthropic processes that conversation under the privacy, retention, and training controls applicable to your Claude account. The plugin does not make a separate upload of the image or alt text.

The plugin is also packaged for Codex and OpenCode. In those hosts, prompts and results are handled under the respective host and model provider's data practices. This plugin's OpenCode adapter only registers the bundled skill and command.

If you separately ask an agent to post content or use a social-network integration, that tool may send information to the selected platform. That is outside this plugin's behavior and is governed by the tool and platform you choose.

## Storage and external services

The plugin contains instruction files and a small host adapter. It has no plugin-operated backend, analytics endpoint, or local store for images or generated alt text. The host may retain conversation data according to its own settings. The plugin itself does not fetch social-media content or contact social networks.