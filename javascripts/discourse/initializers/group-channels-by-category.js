import { withPluginApi } from "discourse/lib/plugin-api";
import { schedule, later } from "@ember/runloop";
import { iconHTML } from "discourse/lib/icon-library";
import cookie, { removeCookie } from "discourse/lib/cookie";

const CATEGORY_HEADER_CLASS = "chat-category-group-header";
const COOKIE_NAME = "chat_plus_collapsed_categories";

function getCategoryNameOverrides() {
  const overrides = new Map();
  const raw = settings.category_name_overrides || "";
  raw.split("\n").forEach((line) => {
    const [original, display] = line.split("|").map((s) => s.trim());
    if (original && display) {
      overrides.set(original, display);
    }
  });
  return overrides;
}

function getCollapsedCategories() {
  const value = cookie(COOKIE_NAME);
  if (!value) return new Set();
  try {
    return new Set(JSON.parse(value));
  } catch {
    return new Set();
  }
}

function saveCollapsedCategories(categories) {
  if (categories.size === 0) {
    removeCookie(COOKIE_NAME);
  } else {
    cookie(COOKIE_NAME, JSON.stringify([...categories]), { path: "/", expires: 365 });
  }
}

function getChannelIdFromElement(el) {
  // Drawer: data attribute on element
  if (el.dataset.chatChannelId) {
    return parseInt(el.dataset.chatChannelId, 10);
  }

  // Sidebar: class or href on child link
  const link = el.querySelector("a.sidebar-section-link");
  if (!link) return null;

  const classMatch = link.className.match(/channel-(\d+)/);
  if (classMatch) {
    return parseInt(classMatch[1], 10);
  }

  const hrefMatch = link.href?.match(/\/chat\/c\/[^/]+\/(\d+)/);
  if (hrefMatch) {
    return parseInt(hrefMatch[1], 10);
  }

  return null;
}

function groupChannelsByCategory(channelsManager) {
  const channels = channelsManager?.publicMessageChannels || [];
  const grouped = new Map();
  const nameOverrides = getCategoryNameOverrides();

  channels.forEach((channel) => {
    const categoryName =
      channel.isCategoryChannel && channel.chatable?.name
        ? channel.chatable.name
        : "Other";

    const categoryColor =
      channel.isCategoryChannel && channel.chatable?.color
        ? channel.chatable.color
        : null;

    if (!grouped.has(categoryName)) {
      grouped.set(categoryName, {
        name: categoryName,
        displayName: nameOverrides.get(categoryName) || categoryName,
        color: categoryColor,
        channelIds: [],
      });
    }

    grouped.get(categoryName).channelIds.push(channel.id);
  });

  return Array.from(grouped.values()).sort((a, b) => {
    if (a.name === "Other") return 1;
    if (b.name === "Other") return -1;
    return a.displayName.localeCompare(b.displayName);
  });
}

function createCategoryHeader(group, collapsed, channelElements, isDrawer = false) {
  const el = document.createElement(isDrawer ? "div" : "li");
  el.className = `${CATEGORY_HEADER_CLASS}${isDrawer ? "" : " sidebar-section-link-wrapper"}`;
  el.dataset.categoryName = group.name;
  el.dataset.collapsed = collapsed;
  el.setAttribute("role", "button");
  el.setAttribute("aria-expanded", !collapsed);

  const inner = document.createElement("div");
  inner.className = `category-header-inner${isDrawer ? "" : " sidebar-row"}`;

  if (settings.show_category_color !== false && group.color) {
    const colorIndicator = document.createElement("span");
    colorIndicator.className = "category-color-indicator";
    colorIndicator.style.backgroundColor = `#${group.color}`;
    inner.appendChild(colorIndicator);
  }

  const nameSpan = document.createElement("span");
  nameSpan.className = "category-name";
  nameSpan.textContent = group.displayName;
  inner.appendChild(nameSpan);

  const iconWrapper = document.createElement("span");
  iconWrapper.className = "category-caret";
  iconWrapper.innerHTML = iconHTML("angle-down");
  inner.appendChild(iconWrapper);

  el.appendChild(inner);
  el._channelElements = channelElements;

  el.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();

    const isCollapsed = el.dataset.collapsed !== "true";
    el.dataset.collapsed = isCollapsed;
    el.setAttribute("aria-expanded", !isCollapsed);

    el._channelElements.forEach((channelEl) => {
      channelEl.dataset.chatPlusCollapsed = isCollapsed;
    });

    const collapsedCategories = getCollapsedCategories();
    if (isCollapsed) {
      collapsedCategories.add(group.name);
    } else {
      collapsedCategories.delete(group.name);
    }
    saveCollapsedCategories(collapsedCategories);
  });

  return el;
}

function reorganizeChannels(container, channelsManager) {
  if (!container || !channelsManager) {
    return;
  }

  if (container.querySelector(`.${CATEGORY_HEADER_CLASS}`)) {
    return;
  }

  const isDrawer = container.classList.contains("channels-list-container");
  const itemSelector = isDrawer
    ? ":scope > .chat-channel-row"
    : ":scope > .sidebar-section-link-wrapper";

  const channelItems = Array.from(container.querySelectorAll(itemSelector));
  if (channelItems.length === 0) {
    return;
  }

  const groups = groupChannelsByCategory(channelsManager);
  if (groups.length === 0) {
    return;
  }

  const defaultCollapsed = settings.collapse_categories_by_default === true;
  const savedCollapsedCategories = getCollapsedCategories();

  const channelItemMap = new Map();
  channelItems.forEach((item) => {
    const channelId = getChannelIdFromElement(item);
    if (channelId) {
      channelItemMap.set(channelId, item);
    }
  });

  const fragment = document.createDocumentFragment();

  groups.forEach((group) => {
    const isCollapsed = savedCollapsedCategories.has(group.name) ||
      (defaultCollapsed && !savedCollapsedCategories.size);

    const channelElements = [];

    group.channelIds.forEach((channelId) => {
      const item = channelItemMap.get(channelId);
      if (item) {
        if (isCollapsed) {
          item.dataset.chatPlusCollapsed = "true";
        }
        channelElements.push(item);
      }
    });

    const header = createCategoryHeader(group, isCollapsed, channelElements, isDrawer);
    fragment.appendChild(header);

    channelElements.forEach((item) => {
      fragment.appendChild(item);
    });
  });

  container.innerHTML = "";
  container.appendChild(fragment);
  container.classList.add("grouped-by-category");
}

export default {
  name: "group-channels-by-category",

  initialize() {
    if (settings.group_channels_by_category === false) {
      return;
    }

    withPluginApi("1.0.0", (api) => {
      let channelsManager = null;

      const tryReorganize = (attempt = 1) => {
        const sidebarContainer = document.querySelector(
          '[data-section-name="chat-channels"] .sidebar-section-content'
        );
        const drawerContainer = document.querySelector(
          '#public-channels.channels-list-container'
        );

        const containers = [sidebarContainer, drawerContainer].filter(Boolean);

        if (!channelsManager) {
          channelsManager = api.container.lookup("service:chat-channels-manager");
        }

        const channels = channelsManager?.publicMessageChannels || [];

        let reorganized = false;
        containers.forEach((container) => {
          if (container.classList.contains("grouped-by-category")) {
            return;
          }

          const isDrawer = container.classList.contains("channels-list-container");
          const itemSelector = isDrawer ? ".chat-channel-row" : ".sidebar-section-link-wrapper";
          const channelItems = container.querySelectorAll(itemSelector);

          if (channelItems.length > 0 && channels.length > 0) {
            reorganizeChannels(container, channelsManager);
            reorganized = true;
          }
        });

        if (!reorganized && attempt < 10) {
          later(() => tryReorganize(attempt + 1), attempt * 300);
        }
      };

      api.onPageChange(() => {
        schedule("afterRender", () => {
          tryReorganize();
        });
      });

      const setupObservers = () => {
        const checkAndReorganize = () => {
          const sidebarContainer = document.querySelector(
            '[data-section-name="chat-channels"] .sidebar-section-content'
          );
          const drawerContainer = document.querySelector(
            '#public-channels.channels-list-container'
          );

          if (
            (sidebarContainer && !sidebarContainer.classList.contains("grouped-by-category")) ||
            (drawerContainer && !drawerContainer.classList.contains("grouped-by-category"))
          ) {
            schedule("afterRender", () => tryReorganize());
          }
        };

        const sidebar = document.querySelector(".sidebar-wrapper");
        if (sidebar) {
          const sidebarObserver = new MutationObserver(checkAndReorganize);
          sidebarObserver.observe(sidebar, { childList: true, subtree: true });
        }

        // Drawer may appear/disappear dynamically
        const bodyObserver = new MutationObserver(() => {
          const drawerContainer = document.querySelector(".chat-drawer-container");
          if (drawerContainer && !drawerContainer._chatPlusObserving) {
            drawerContainer._chatPlusObserving = true;
            const drawerObserver = new MutationObserver(checkAndReorganize);
            drawerObserver.observe(drawerContainer, { childList: true, subtree: true });
            checkAndReorganize();
          }
        });
        bodyObserver.observe(document.body, { childList: true, subtree: true });
      };

      schedule("afterRender", setupObservers);
    });
  },
};
