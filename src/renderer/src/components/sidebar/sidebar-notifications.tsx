import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { BellIcon } from "@primer/octicons-react";
import cn from "classnames";

import { ACCOUNTLESS } from "@shared";
import { logger } from "@renderer/logger";

const NOTIFICATIONS_PATH = "/notifications";

/**
 * Accountless entry point to the notifications page. The account-mode surface
 * lives in `SidebarProfile` (a dropdown that is hidden accountless), so this
 * bell keeps local notifications reachable on the desktop without any auth
 * call. It only renders in the accountless fork.
 */
export function SidebarNotifications() {
  if (!ACCOUNTLESS) return null;

  return <SidebarNotificationsInner />;
}

function SidebarNotificationsInner() {
  const { t } = useTranslation("sidebar");
  const navigate = useNavigate();
  const location = useLocation();

  const [notificationCount, setNotificationCount] = useState(0);

  const fetchLocalNotificationCount = useCallback(async () => {
    try {
      const count = await window.electron.getLocalNotificationsCount();
      setNotificationCount(count);
    } catch (error) {
      logger.error("Failed to fetch local notification count", error);
    }
  }, []);

  useEffect(() => {
    void fetchLocalNotificationCount();
  }, [fetchLocalNotificationCount]);

  useEffect(() => {
    const unsubscribe = window.electron.onLocalNotificationCreated(() => {
      void fetchLocalNotificationCount();
    });
    return () => unsubscribe();
  }, [fetchLocalNotificationCount]);

  useEffect(() => {
    const handleNotificationsChanged = () => {
      void fetchLocalNotificationCount();
    };
    window.addEventListener("notificationsChanged", handleNotificationsChanged);
    return () =>
      window.removeEventListener(
        "notificationsChanged",
        handleNotificationsChanged
      );
  }, [fetchLocalNotificationCount]);

  const handleClick = () => {
    if (location.pathname !== NOTIFICATIONS_PATH) {
      navigate(NOTIFICATIONS_PATH);
    }
  };

  return (
    <li
      className={cn("sidebar__menu-item", {
        "sidebar__menu-item--active": location.pathname === NOTIFICATIONS_PATH,
      })}
    >
      <button
        type="button"
        className="sidebar__menu-item-button"
        onClick={handleClick}
      >
        <BellIcon size={16} />
        <span className="sidebar__menu-item-button-label">
          {t("notifications")}
        </span>
        {notificationCount > 0 && (
          <span className="sidebar__notification-badge">
            {notificationCount > 99 ? "99+" : notificationCount}
          </span>
        )}
      </button>
    </li>
  );
}
