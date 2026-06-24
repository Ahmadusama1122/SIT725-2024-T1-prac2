const axios = require("axios");
const fs = require("fs");
const config = require("./pipeline-config");

// ---------------------------------------------------------------------------
// LinkedIn API — post content to profile with optional image
// ---------------------------------------------------------------------------

/**
 * Upload an image to LinkedIn and get the media URN.
 * @param {string} imagePath — local path to the PNG file
 * @returns {string} — the media asset URN
 */
async function uploadImage(imagePath) {
  const author = config.linkedinOrgUrn || config.linkedinMemberUrn;

  // Step 1 — Register the upload
  const registerPayload = {
    registerUploadRequest: {
      recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
      owner: author,
      serviceRelationships: [
        {
          relationshipType: "OWNER",
          identifier: "urn:li:userGeneratedContent",
        },
      ],
    },
  };

  const registerRes = await axios.post(
    "https://api.linkedin.com/v2/assets?action=registerUpload",
    registerPayload,
    {
      headers: {
        Authorization: `Bearer ${config.linkedinAccessToken}`,
        "Content-Type": "application/json",
      },
    }
  );

  const uploadUrl =
    registerRes.data.value.uploadMechanism[
      "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"
    ].uploadUrl;
  const mediaAsset = registerRes.data.value.asset;

  // Step 2 — Upload the image binary
  const imageBuffer = fs.readFileSync(imagePath);
  await axios.put(uploadUrl, imageBuffer, {
    headers: {
      Authorization: `Bearer ${config.linkedinAccessToken}`,
      "Content-Type": "image/png",
    },
    maxBodyLength: Infinity,
  });

  return mediaAsset;
}

/**
 * Post text content to LinkedIn, optionally with an image.
 * @param {string} text — the post body
 * @param {string} [imagePath] — optional path to a PNG image to attach
 * @returns {object} — LinkedIn API response
 */
async function postToLinkedIn(text, imagePath) {
  if (!config.linkedinAccessToken) {
    throw new Error("LINKEDIN_ACCESS_TOKEN not set — run: node setup/linkedin-auth.js");
  }

  const author = config.linkedinOrgUrn || config.linkedinMemberUrn;
  if (!author) {
    throw new Error("Neither LINKEDIN_ORG_URN nor LINKEDIN_MEMBER_URN is set — run: node setup/linkedin-auth.js");
  }

  const isOrg = author.includes("organization");
  console.log(`  Posting to: ${isOrg ? "company page" : "personal profile"} (${author})`);

  // Upload image if provided
  let mediaAsset;
  if (imagePath && fs.existsSync(imagePath)) {
    console.log(`  Uploading image: ${imagePath}`);
    try {
      mediaAsset = await uploadImage(imagePath);
      console.log(`  Image uploaded: ${mediaAsset}`);
    } catch (err) {
      console.warn(`  Image upload failed, posting text-only: ${err.message}`);
      mediaAsset = null;
    }
  }

  const shareContent = mediaAsset
    ? {
        shareCommentary: { text },
        shareMediaCategory: "IMAGE",
        media: [
          {
            status: "READY",
            media: mediaAsset,
          },
        ],
      }
    : {
        shareCommentary: { text },
        shareMediaCategory: "NONE",
      };

  const payload = {
    author,
    lifecycleState: "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": shareContent,
    },
    visibility: {
      "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
    },
  };

  try {
    const res = await axios.post(
      "https://api.linkedin.com/v2/ugcPosts",
      payload,
      {
        headers: {
          Authorization: `Bearer ${config.linkedinAccessToken}`,
          "Content-Type": "application/json",
          "X-Restli-Protocol-Version": "2.0.0",
        },
      }
    );
    return { success: true, id: res.data.id, status: res.status };
  } catch (err) {
    const errData = err.response?.data || err.message;
    throw new Error(`LinkedIn post failed: ${JSON.stringify(errData)}`);
  }
}

module.exports = { postToLinkedIn };
