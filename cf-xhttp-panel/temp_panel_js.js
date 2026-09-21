window.globalFragLen = "20-30";
        window.globalFragInt = "1-2";

        const tlsPorts = ['443', '2053', '2083', '2087', '2096', '8443'];
        const nonTlsPorts = ['80', '8080', '8880', '2052', '2082', '2086', '2095'];

        let isEditMode = false;
        let editingUsername = '';

        // Toast notification system
        function showToast(message, type) {
            type = type || 'info';
            const container = document.getElementById('toast-container');
            const colors = {
                success: { bg: 'rgba(32,33,36,0.97)', border: 'rgba(129,201,149,0.4)', icon: '#81c995', dot: '#81c995' },
                error: { bg: 'rgba(32,33,36,0.97)', border: 'rgba(242,139,130,0.4)', icon: '#f28b82', dot: '#f28b82' },
                warning: { bg: 'rgba(32,33,36,0.97)', border: 'rgba(253,226,147,0.4)', icon: '#fde293', dot: '#fde293' },
                info: { bg: 'rgba(32,33,36,0.97)', border: 'rgba(138,180,248,0.4)', icon: '#8ab4f8', dot: '#8ab4f8' }
            };
            const c = colors[type] || colors.info;
            const icons = {
                success: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/>',
                error: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"/>',
                warning: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>',
                info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'
            };
            const toast = document.createElement('div');
            toast.className = 'toast-enter';
            toast.style.cssText = 'display:flex;align-items:center;gap:10px;padding:11px 16px;background:' + c.bg + ';border:1px solid ' + c.border + ';border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,0.5);pointer-events:auto;max-width:340px;min-width:200px;cursor:pointer;';
            toast.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="' + c.icon + '" stroke-width="2">' + (icons[type]||icons.info) + '</svg>' +
                '<span style="font-size:13px;font-weight:600;color:#e8eaed;flex:1;font-family:Vazirmatn,sans-serif;">' + message + '</span>';
            toast.onclick = function() { removeToast(toast); };
            container.appendChild(toast);
            setTimeout(function() { removeToast(toast); }, 4000);
        }
        function removeToast(toast) {
            if (!toast.parentNode) return;
            toast.className = 'toast-exit';
            setTimeout(function() { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 250);
        }

        function renderPortCheckboxes() {
            const tlsContainer = document.getElementById('tls-ports-list');
            const nonTlsContainer = document.getElementById('nontls-ports-list');

            tlsContainer.innerHTML = tlsPorts.map(function(port) {
                var isCheckedDefault = port === '443' ? 'checked' : '';
                return '<label style="cursor:pointer;">' +
                    '<input type="checkbox" name="ports" value="' + port + '" ' + isCheckedDefault + ' class="checkbox-port">' +
                    '<div class="port-label">' + port + '</div>' +
                '</label>';
            }).join('');

            nonTlsContainer.innerHTML = nonTlsPorts.map(function(port) {
                return '<label style="cursor:pointer;">' +
                    '<input type="checkbox" name="ports" value="' + port + '" class="checkbox-port nontls">' +
                    '<div class="port-label">' + port + '</div>' +
                '</label>';
            }).join('');
        }

        // Initialize 443 active state immediately
        setTimeout(function() {
            const cb443 = document.querySelector('input[name="ports"][value="443"]');
            if (cb443) cb443.checked = true;
        }, 100);

        function toggleSettingsModal(show) {
            const modal = document.getElementById('settings-modal');
            if (show) {
                modal.classList.add('open');
            } else {
                modal.classList.remove('open');
            }
        }

        function toggleModal(show) {
            const modal = document.getElementById('user-modal');
            if (show) {
                modal.classList.add('open');
            } else {
                modal.classList.remove('open');
                isEditMode = false;
                editingUsername = '';
                document.getElementById('modal-title').innerText = 'ایجاد کاربر جدید';
                document.getElementById('submit-btn').innerText = 'ایجاد کاربر';
                document.getElementById('input-name').disabled = false;
                document.getElementById('create-user-form').reset();
                // Ensure port 443 remains checked as default when form is reset
                const cb443 = document.querySelector('input[name="ports"][value="443"]');
                if (cb443) cb443.checked = true;
            }
        }

        function openCreateModal() {
            isEditMode = false;
            editingUsername = '';
            document.getElementById('modal-title').innerText = 'ایجاد کاربر جدید';
            document.getElementById('submit-btn').innerText = 'ایجاد کاربر';
            document.getElementById('input-name').disabled = false;
            document.getElementById('create-user-form').reset();

            document.getElementById('input-proxy-select').value = '';
            document.getElementById('input-proxy').style.display = 'none';
            document.getElementById('input-proxy').value = '';

            toggleModal(true);
        }

        async function loadUsers(silent = false) {
            const loadingState = document.getElementById('loading-state');
            const tableContainer = document.getElementById('users-table-container');
            const emptyState = document.getElementById('empty-state');
            
            if (!silent) {
                loadingState.classList.remove('hidden');
                tableContainer.classList.add('hidden');
                emptyState.classList.add('hidden');
            }
            
            try {
                const res = await fetch('/api/users?t=' + Date.now());
                if (!res.ok) throw new Error();
                const data = await res.json();
                renderUsersUI(data);
            } catch (err) {
                if (!silent) {
                    loadingState.innerHTML = '<span style="color:#f28b82;font-size:13px;">خطا در دریافت اطلاعات از سرور</span>';
                }
            }
        }

        function renderUsersUI(data) {
            try {
                const users = data.users || [];
                window.allUsers = users;
                const serverTime = data.serverTime || Date.now();
                window.lastServerTime = serverTime;
                
                const totalUsersCount = users.length;
                const activeUsersCount = users.filter(u => u.is_online === 1).length;
                const totalGbUsage = users.reduce((sum, u) => sum + (u.used_gb || 0), 0);
                
                document.getElementById('stat-total-users').innerText = totalUsersCount;
                document.getElementById('stat-active-users').innerText = activeUsersCount;
                document.getElementById('stat-total-usage').innerText = totalGbUsage < 1 ? (totalGbUsage * 1024).toFixed(0) + ' MB' : totalGbUsage.toFixed(2) + ' GB';
                
                const topUser = users.reduce((max, u) => (u.used_gb || 0) > (max.used_gb || 0) ? u : max, { username: 'هیچکدام', used_gb: 0 });
                document.getElementById('stat-top-user').innerText = topUser.username;
                const topUsage = topUser.used_gb || 0;
                document.getElementById('stat-top-user-usage').innerText = topUsage < 1 ? (topUsage * 1024).toFixed(0) + ' MB مصرف شده' : topUsage.toFixed(2) + ' GB مصرف شده';

                filterAndRenderUsers();
            } catch (err) {
                document.getElementById('loading-state').innerHTML = '<span style="color:#f28b82;font-size:13px;">خطا در پردازش اطلاعات کاربران</span>';
            }
        }

        function filterAndRenderUsers() {
            if (!window.allUsers) return;
            const searchQuery = (document.getElementById('search-input').value || '').toLowerCase().trim();
            const filterStatus = document.getElementById('filter-status').value;
            const sortVal = document.getElementById('sort-users').value;
            const serverTime = window.lastServerTime || Date.now();
            
            let filtered = [...window.allUsers];
            
            // Search filter
            if (searchQuery) {
                filtered = filtered.filter(u => 
                    (u.username || '').toLowerCase().includes(searchQuery) || 
                    (u.uuid || '').toLowerCase().includes(searchQuery)
                );
            }
            
            // Status filter
            if (filterStatus !== 'all') {
                filtered = filtered.filter(u => {
                    const isOnline = u.is_online === 1;
                    const isActive = u.is_active === 1;
                    
                    let isExpired = false;
                    if (u.limit_gb && u.used_gb >= u.limit_gb) isExpired = true;
                    if (u.expiry_days && u.created_at) {
                        const created = new Date(u.created_at);
                        const expiryDate = new Date(created.getTime() + (u.expiry_days * 24 * 60 * 60 * 1000));
                        if (new Date(serverTime) > expiryDate) isExpired = true;
                    }
                    
                    if (filterStatus === 'active') return isActive && !isExpired;
                    if (filterStatus === 'inactive') return !isActive;
                    if (filterStatus === 'online') return isOnline;
                    if (filterStatus === 'offline') return !isOnline;
                    if (filterStatus === 'expired') return isExpired || !isActive;
                    return true;
                });
            }
            
            // Sort
            filtered.sort((a, b) => {
                if (sortVal === 'newest') {
                    return b.id - a.id;
                }
                if (sortVal === 'name') {
                    return (a.username || '').localeCompare(b.username || '');
                }
                if (sortVal === 'usage-desc') {
                    return (b.used_gb || 0) - (a.used_gb || 0);
                }
                if (sortVal === 'usage-asc') {
                    return (a.used_gb || 0) - (b.used_gb || 0);
                }
                if (sortVal === 'expiry-asc') {
                    const getRemaining = (u) => {
                        if (!u.expiry_days) return Infinity;
                        if (!u.created_at) return Infinity;
                        const created = new Date(u.created_at);
                        const expiryDate = new Date(created.getTime() + (u.expiry_days * 24 * 60 * 60 * 1000));
                        return expiryDate - new Date(serverTime);
                    };
                    return getRemaining(a) - getRemaining(b);
                }
                return 0;
            });
            
            renderFilteredUsers(filtered, serverTime);
        }

        function renderFilteredUsers(users, serverTime) {
            const loadingState = document.getElementById('loading-state');
            const tableContainer = document.getElementById('users-table-container');
            const emptyState = document.getElementById('empty-state');
            const tbody = document.getElementById('users-tbody');
            
            if (users.length === 0) {
                loadingState.classList.add('hidden');
                emptyState.classList.remove('hidden');
                tableContainer.classList.add('hidden');
                if (window.allUsers && window.allUsers.length > 0) {
                    document.getElementById('empty-state-msg').innerText = 'کاربری با مشخصات جستجو شده یافت نشد.';
                } else {
                    document.getElementById('empty-state-msg').innerText = 'کاربری وجود ندارد. برای ساخت اولین کاربر روی دکمه «+» کلیک کنید.';
                }
            } else {
                loadingState.classList.add('hidden');
                emptyState.classList.add('hidden');
                tableContainer.classList.remove('hidden');
                
                tbody.innerHTML = users.map(user => {
                    const createdDate = user.created_at ? new Date(user.created_at).toLocaleDateString('fa-IR') : '-';
                    let daysRemaining = 'نامحدود';
                    let daysPercent = 100;
                    if (user.expiry_days) {
                        if (user.created_at) {
                            const created = new Date(user.created_at);
                            const expiryDate = new Date(created.getTime() + (user.expiry_days * 24 * 60 * 60 * 1000));
                            const diffDays = Math.ceil((expiryDate - new Date(serverTime)) / (1000 * 60 * 60 * 24));
                            daysRemaining = diffDays > 0 ? diffDays : 0;
                            daysPercent = Math.max(0, Math.min(100, (daysRemaining / user.expiry_days) * 100));
                        } else {
                            daysRemaining = user.expiry_days;
                        }
                    }

                    const usedGb = user.used_gb || 0;
                    const formattedUsed = usedGb < 1 ? (usedGb * 1024).toFixed(0) + ' MB' : usedGb.toFixed(2) + ' GB';

                    let volumeHtml = '';
                    if (user.limit_gb) {
                        const limitPercent = Math.min((usedGb / user.limit_gb) * 100, 100);
                        const limitHue = 120 - (limitPercent * 1.2);
                        const formattedLimit = user.limit_gb < 1 ? (user.limit_gb * 1024).toFixed(0) + ' MB' : user.limit_gb + ' GB';
                        volumeHtml = '<div class="flex flex-col gap-1.5 w-full min-w-[130px]">' +
                            '<div class="flex justify-between text-[11px] text-gray-500 dark:text-gray-400 font-medium">' +
                                '<span>مصرف: ' + formattedUsed + '</span>' +
                                '<span>کل: ' + formattedLimit + '</span>' +
                            '</div>' +
                            '<div class="w-full bg-gray-200 dark:bg-zinc-700 rounded-full h-1.5 overflow-hidden">' +
                                '<div class="h-1.5 rounded-full transition-all duration-500" style="width: ' + limitPercent + '%; background-color: hsl(' + limitHue + ', 80%, 45%)"></div>' +
                            '</div>' +
                        '</div>';
                    } else {
                        volumeHtml = '<div class="flex flex-col gap-1.5 w-full min-w-[130px]">' +
                            '<div class="flex justify-between text-[11px] text-gray-500 dark:text-gray-400 font-medium">' +
                                '<span>مصرف: ' + formattedUsed + '</span>' +
                                '<span>کل: نامحدود</span>' +
                            '</div>' +
                            '<div class="w-full bg-gray-200 dark:bg-zinc-700 rounded-full h-1.5 overflow-hidden">' +
                                '<div class="bg-blue-500 h-1.5 rounded-full transition-all duration-500" style="width: 100%"></div>' +
                            '</div>' +
                        '</div>';
                    }

                    let dailyHtml = '';
                    {
                        const dailyUsed = user.daily_used_gb || 0;
                        const fmtDailyUsed = dailyUsed < 1 ? (dailyUsed * 1024).toFixed(0) + ' MB' : dailyUsed.toFixed(2) + ' GB';
                        if (user.daily_limit_gb) {
                            const dPercent = Math.min((dailyUsed / user.daily_limit_gb) * 100, 100);
                            const dHue = 120 - (dPercent * 1.2);
                            const fmtDailyLimit = user.daily_limit_gb < 1 ? (user.daily_limit_gb * 1024).toFixed(0) + ' MB' : user.daily_limit_gb + ' GB';
                            dailyHtml = '<div class="flex flex-col gap-1 w-full min-w-[130px] mt-2 pt-2 border-t border-dashed border-gray-200 dark:border-zinc-800">' +
                                '<div class="flex justify-between text-[10px] text-gray-400 font-medium">' +
                                    '<span>امروز: ' + fmtDailyUsed + '</span>' +
                                    '<span>روزانه: ' + fmtDailyLimit + '</span>' +
                                '</div>' +
                                '<div class="w-full bg-gray-200 dark:bg-zinc-700 rounded-full h-1 overflow-hidden">' +
                                    '<div class="h-1 rounded-full transition-all duration-500" style="width: ' + dPercent + '%; background-color: hsl(' + dHue + ', 80%, 45%)"></div>' +
                                '</div>' +
                            '</div>';
                        } else {
                            dailyHtml = '<div class="text-[10px] text-gray-400 mt-2 pt-2 border-t border-dashed border-gray-200 dark:border-zinc-800">امروز: ' + fmtDailyUsed + ' • روزانه: نامحدود</div>';
                        }
                    }

                    let expiryHtml = '';
                    if (user.expiry_days) {
                        const expiryHue = daysPercent * 1.2;
                        expiryHtml = '<div class="flex flex-col gap-1.5 w-full min-w-[130px]">' +
                            '<div class="flex justify-between text-[11px] text-gray-500 dark:text-gray-400 font-medium">' +
                                '<span>باقی‌مانده: ' + daysRemaining + ' روز</span>' +
                                '<span>کل: ' + user.expiry_days + ' روز</span>' +
                            '</div>' +
                            '<div class="w-full bg-gray-200 dark:bg-zinc-700 rounded-full h-1.5 overflow-hidden flex justify-end">' +
                                '<div class="h-1.5 rounded-full transition-all duration-500" style="width: ' + daysPercent + '%; background-color: hsl(' + expiryHue + ', 80%, 45%)"></div>' +
                            '</div>' +
                        '</div>';
                    } else {
                        expiryHtml = '<div class="flex flex-col gap-1.5 w-full min-w-[130px]">' +
                            '<div class="flex justify-between text-[11px] text-gray-500 dark:text-gray-400 font-medium">' +
                                '<span>باقی‌مانده: نامحدود</span>' +
                                '<span>کل: نامحدود</span>' +
                            '</div>' +
                            '<div class="w-full bg-gray-200 dark:bg-zinc-700 rounded-full h-1.5 overflow-hidden flex justify-end">' +
                                '<div class="bg-blue-500 h-1.5 rounded-full transition-all duration-500" style="width: 100%"></div>' +
                            '</div>' +
                        '</div>';
                    }

                    const statusBtnColor = user.is_active === 0 ? 'text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/30' : 'text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/30';
                    const statusBtnTitle = user.is_active === 0 ? 'فعال کردن کاربر' : 'قطع کردن کاربر';
                    const statusBtnIcon = user.is_active === 0 
                        ? '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>'
                        : '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>';

                    return '<tr class="hover:bg-gray-50 dark:hover:bg-zinc-900/40 border-b border-gray-100 dark:border-zinc-800 last:border-0">' +
                            '<td class="p-4">' +
                                '<div class="flex flex-col gap-3">' +
                                    '<div class="flex items-center gap-2">' +
                                        '<span class="font-bold text-gray-900 dark:text-zinc-100">' + user.username + '</span>' +
                                        (user.is_active === 0 ? '<span class="px-1.5 py-0.5 text-[10px] font-medium bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400 rounded-md">قطع</span>' : '<span class="px-1.5 py-0.5 text-[10px] font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 rounded-md">فعال</span>') +
                                        (user.is_online === 1 ? '<span class="px-1.5 py-0.5 text-[10px] font-medium bg-emerald-500 text-white rounded-md animate-pulse">● آنلاین</span>' : '<span class="px-1.5 py-0.5 text-[10px] font-medium bg-gray-200 text-gray-600 dark:bg-zinc-800 dark:text-zinc-400 rounded-md">آفلاین</span>') +
                                    '</div>' +
                                    '<div class="flex gap-1.5">' +
                                        '<button onclick="copyConfig(\'' + encodeURIComponent(user.username) + '\')" title="کپی کانفیگ" class="p-1.5 bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 hover:bg-blue-50 dark:hover:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-md transition shadow-sm"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg></button>' +
                                        '<button onclick="copyJsonConfig(\'' + encodeURIComponent(user.username) + '\')" title="کپی JSON" class="p-1.5 bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 hover:bg-purple-50 dark:hover:bg-purple-900/30 text-purple-600 dark:text-purple-400 rounded-md transition shadow-sm"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"></path></svg></button>' +
                                        '<button onclick="showQR(\'' + encodeURIComponent(user.username) + '\')" title="کد QR" class="p-1.5 bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 hover:bg-green-50 dark:hover:bg-green-900/30 text-green-600 dark:text-green-400 rounded-md transition shadow-sm"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm14 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"></path></svg></button>' +
                                        '<button onclick="toggleUserStatus(\'' + encodeURIComponent(user.username) + '\')" title="' + statusBtnTitle + '" class="p-1.5 bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 ' + statusBtnColor + ' rounded-md transition shadow-sm">' + statusBtnIcon + '</button>' +
                                        '<button onclick="editUser(\'' + encodeURIComponent(user.username) + '\')" title="ویرایش" class="p-1.5 bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 hover:bg-yellow-50 dark:hover:bg-yellow-900/30 text-yellow-600 dark:text-yellow-400 rounded-md transition shadow-sm"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg></button>' +
                                        '<button onclick="deleteUser(\'' + encodeURIComponent(user.username) + '\')" title="حذف" class="p-1.5 bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 hover:bg-red-50 dark:hover:bg-red-950/20 text-red-600 dark:text-red-400 rounded-md transition shadow-sm"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>' +
                                    '</div>' +
                                '</div>' +
                            '</td>' +
                            '<td class="p-4">' +
                                '<div class="flex flex-col gap-2 min-w-[140px]">' +
                                    '<div class="flex gap-1">' +
                                        '<button onclick="copySubLink(\'' + encodeURIComponent(user.username) + '\')" class="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 rounded-lg text-xs font-bold transition border border-indigo-200 dark:border-indigo-800">' +
                                            '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"></path></svg>' +
                                            'ساب متنی' +
                                        '</button>' +
                                        '<button onclick="showSubQR(\'' + encodeURIComponent(user.username) + '\', \'normal\')" title="QR ساب متنی" class="px-2 py-1.5 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 rounded-lg text-xs font-bold transition border border-indigo-200 dark:border-indigo-800">' +
                                            '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm14 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"></path></svg>' +
                                        '</button>' +
                                    '</div>' +
                                    '<div class="flex gap-1">' +
                                        '<button onclick="copyJsonSubLink(\'' + encodeURIComponent(user.username) + '\')" class="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 hover:bg-purple-100 dark:hover:bg-purple-900/50 rounded-lg text-xs font-bold transition border border-purple-200 dark:border-purple-800">' +
                                            '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"></path></svg>' +
                                            'ساب JSON' +
                                        '</button>' +
                                        '<button onclick="showSubQR(\'' + encodeURIComponent(user.username) + '\', \'json\')" title="QR ساب JSON" class="px-2 py-1.5 bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 hover:bg-purple-100 dark:hover:bg-purple-900/50 rounded-lg text-xs font-bold transition border border-purple-200 dark:border-purple-800">' +
                                            '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm14 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"></path></svg>' +
                                        '</button>' +
                                    '</div>' +
                                    '<div class="flex gap-1">' +
                                        '<button onclick="copyStatusLink(\'' + encodeURIComponent(user.username) + '\')" class="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 rounded-lg text-xs font-bold transition border border-emerald-200 dark:border-emerald-800">' +
                                            '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>' +
                                            'صفحه وضعیت' +
                                        '</button>' +
                                    '</div>' +
                                '</div>' +
                            '</td>' +
                            '<td class="p-4 text-xs font-mono uppercase text-blue-500 font-semibold">VLESS</td>' +
                            '<td class="p-4 text-xs">' + 
                                '<div class="flex flex-wrap gap-1 max-w-[160px]">' +
                                    String(user.port || "").split(",").map(function(p) {
                                        p = p.trim();
                                        if (!p) return "";
                                        var isTls = tlsPorts.includes(p);
                                        return '<span class="inline-block px-1.5 py-0.5 text-[10px] font-semibold rounded ' + (isTls ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400' : 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400') + '">' + p + '</span>';
                                    }).join("") +
                                '</div>' +
                            '</td>' +
                            '<td class="p-4">' + volumeHtml + dailyHtml + '</td>' +
                            '<td class="p-4">' + expiryHtml + '</td>' +
                            '<td class="p-4 text-xs text-gray-500">' + createdDate + '</td>' +
                        '</tr>';
                }).join('');
            }
        }

        async function toggleUserStatus(encodedUsername) {
            const username = decodeURIComponent(encodedUsername);
            try {
                const response = await fetch('/api/users/' + encodeURIComponent(username), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ toggle_only: true })
                });
                if (response.ok) {
                    await loadUsers(true);
                } else {
                    const errData = await response.json();
                    showToast('خطا: ' + (errData.error || 'عملیات ناموفق بود'), 'error');
                }
            } catch (err) {
                showToast('خطا در برقراری ارتباط با سرور', 'error');
            }
        }
        async function handleFormSubmit(event) {
            event.preventDefault();
            const submitButton = document.getElementById('submit-btn');
            submitButton.disabled = true;
            submitButton.innerText = isEditMode ? 'در حال ذخیره تغییرات...' : 'در حال ایجاد...';

            const username = document.getElementById('input-name').value;
            const limit = document.getElementById('input-limit').value || null;
            const daily = document.getElementById('input-daily').value || null;
            const expiry = document.getElementById('input-expiry').value || null;
            
            // Gather multiple selected ports
            const checkedPorts = Array.from(document.querySelectorAll('input[name="ports"]:checked')).map(cb => cb.value);
            
            // Validation: Ensure at least one port is selected
            if (checkedPorts.length === 0) {
                showToast('لطفا حداقل یک پورت را برای اتصال انتخاب کنید!', 'warning');
                submitButton.disabled = false;
                submitButton.innerText = isEditMode ? 'ذخیره تغییرات' : 'ایجاد کاربر';
                return;
            }

            const port = checkedPorts.join(',');
            const tls = checkedPorts.some(p => tlsPorts.includes(p)) ? 'on' : 'off';
            
            const ips = document.getElementById('input-ips').value;
            
            let proxy_ip = document.getElementById('input-proxy-select').value;
            if (proxy_ip === 'custom') {
                proxy_ip = document.getElementById('input-proxy').value;
            }

            const fingerprint = document.getElementById('fingerprint-select').value;

            const url = isEditMode ? '/api/users/' + encodeURIComponent(editingUsername) : '/api/users';
            const method = isEditMode ? 'PUT' : 'POST';

            try {
                const response = await fetch(url, {
                    method: method,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, limit_gb: limit, daily_limit_gb: daily, expiry_days: expiry, tls, port, ips, proxy_ip, fingerprint })
                });
                
                if (response.ok) {
                    toggleModal(false);
                    await loadUsers(true);
                } else {
                    const errData = await response.json();
                    showToast('خطا: ' + (errData.error || 'عملیات ناموفق بود'), 'error');
                }
            } catch (err) {
                showToast('خطا در برقراری ارتباط با سرور', 'error');
            } finally {
                submitButton.disabled = false;
                submitButton.innerText = isEditMode ? 'ذخیره تغییرات' : 'ایجاد کاربر';
            }
        }

        function toggleQRModal(show, link, title) {
            link = link || '';
            title = title || 'اسکن کد QR';
            const modal = document.getElementById('qr-modal');
            const qrBox = document.getElementById('qrcode-box');
            const titleEl = document.getElementById('qr-modal-title');
            if (show) {
                titleEl.innerText = title;
                qrBox.innerHTML = '';
                new QRCode(qrBox, {
                    text: link,
                    width: 192,
                    height: 192,
                    colorDark : "#000000",
                    colorLight : "#ffffff",
                    correctLevel : QRCode.CorrectLevel.M
                });
                modal.classList.add('open');
            } else {
                modal.classList.remove('open');
            }
        }

        function getVlessLink(username) {
            const user = window.allUsers.find(u => u.username === username);
            if (!user) return '';
            const host = window.location.hostname;
            
            let ips = [host];
            if (user.ips) {
                const parsedIps = user.ips.split('\n').map(ip => ip.trim()).filter(ip => ip.length > 0);
                if (parsedIps.length > 0) ips = parsedIps;
            }
            
            const ports = String(user.port || '443').split(',').map(p => p.trim()).filter(p => p.length > 0);
            const fp = user.fingerprint || 'chrome';
            const links = [];

            ips.forEach((ip, ipIndex) => {
                ports.forEach((portStr) => {
                    const isTlsPort = tlsPorts.includes(portStr);
                    const tlsVal = isTlsPort ? 'tls' : 'none';
                    const remark = ips.length > 1 
                        ? (user.username + '-' + (ipIndex + 1) + '-' + portStr) 
                        : (user.username + '-' + portStr);
                    
                    links.push('vle' + 'ss://' + (user.uuid || '') + '@' + ip + ':' + portStr + '?type=xhttp&security=' + tlsVal + '&sni=' + host + '&host=' + host + '&path=%2F&fp=' + fp + '&encryption=none&allowInsecure=0&extra=' + encodeURIComponent(JSON.stringify({mode:'auto',maxUploadSize:1000000,maxConcurrentUploads:10})) + '#' + encodeURIComponent(remark));
                });
            });

            return links.join('\n');
        }

        function getSubLink(username) {
            return window.location.origin + '/feed/' + encodeURIComponent(username);
        }

        function getJsonSubLink(username) {
            return window.location.origin + '/feed/json/' + encodeURIComponent(username);
        }

        function getStatusLink(username) {
            return window.location.origin + '/status/' + encodeURIComponent(username);
        }

        function copySubLink(encodedUsername) {
            const username = decodeURIComponent(encodedUsername);
            navigator.clipboard.writeText(getSubLink(username)).then(() => {
                showToast('لینک ساب متنی با موفقیت کپی شد!', 'success');
            }).catch(() => {
                showToast('خطا در کپی کردن لینک ساب!', 'error');
            });
        }

        function copyStatusLink(encodedUsername) {
            const username = decodeURIComponent(encodedUsername);
            navigator.clipboard.writeText(getStatusLink(username)).then(() => {
                showToast('لینک صفحه وضعیت با موفقیت کپی شد!', 'success');
            }).catch(() => {
                showToast('خطا در کپی کردن لینک صفحه وضعیت!', 'error');
            });
        }

        function copyJsonSubLink(encodedUsername) {
            const username = decodeURIComponent(encodedUsername);
            navigator.clipboard.writeText(getJsonSubLink(username)).then(() => {
                showToast('لینک ساب JSON با موفقیت کپی شد!', 'success');
            }).catch(() => {
                showToast('خطا در کپی کردن لینک ساب JSON!', 'error');
            });
        }

        function showSubQR(encodedUsername, type) {
            const username = decodeURIComponent(encodedUsername);
            if (type === 'normal') {
                toggleQRModal(true, getSubLink(username), 'QR ساب متنی');
            } else if (type === 'json') {
                toggleQRModal(true, getJsonSubLink(username), 'QR ساب JSON');
            }
        }

        function copyConfig(encodedUsername) {
            const username = decodeURIComponent(encodedUsername);
            const link = getVlessLink(username);
            if (!link) return;
            navigator.clipboard.writeText(link).then(() => {
                showToast('کانفیگ VLESS با موفقیت کپی شد!', 'success');
            }).catch(() => {
                showToast('خطا در کپی کردن کانفیگ!', 'error');
            });
        }

        function copyJsonConfig(encodedUsername) {
            const username = decodeURIComponent(encodedUsername);
            const user = window.allUsers.find(u => u.username === username);
            if (!user) return;
            const host = window.location.hostname;
            let ips = [host];
            if (user.ips) {
                ips = user.ips.split('\n').map(ip => ip.trim()).filter(ip => ip.length > 0);
                if (ips.length === 0) ips = [host];
            }
            
            const ports = String(user.port || '443').split(',').map(p => p.trim()).filter(p => p.length > 0);
            const fp = user.fingerprint || 'chrome';

            const configArray = [];
            ips.forEach((ip, ipIndex) => {
              ports.forEach((portStr) => {
                const isTlsPort = tlsPorts.includes(portStr);
                const tlsVal = isTlsPort ? 'tls' : 'none';
                const remark = ips.length > 1 ? (user.username + ' - IP ' + (ipIndex + 1) + ' - Port ' + portStr) : (user.username + ' - Port ' + portStr);
                
                const jsonConfig = {
                  "remarks": remark,
                  "version": { "min": "25.10.15" },
                  "log": { "loglevel": "none" },
                  "dns": {
                    "servers": [
                      { "address": "https://8.8.8.8/dns-query", "tag": "remote-dns" },
                      { "address": "8.8.8.8", "domains": ["full:" + host], "skipFallback": true }
                    ],
                    "queryStrategy": "UseIP",
                    "tag": "dns"
                  },
                  "inbounds": [
                    {
                      "listen": "127.0.0.1", "port": 10808, "protocol": "socks",
                      "settings": { "auth": "noauth", "udp": true },
                      "sniffing": { "destOverride": ["http", "tls"], "enabled": true, "routeOnly": true },
                      "tag": "mixed-in"
                    },
                    {
                      "listen": "127.0.0.1", "port": 10853, "protocol": "dokodemo-door",
                      "settings": { "address": "1.1.1.1", "network": "tcp,udp", "port": 53 },
                      "tag": "dns-in"
                    }
                  ],
                  "outbounds": [
                    {
                      "protocol": "vle" + "ss",
                      "settings": {
                        ["vne" + "xt"]: [
                          { "address": ip, "port": parseInt(portStr), "users": [{ "id": user.uuid, "encryption": "none" }] }
                        ]
                      },
                      ["stream" + "Settings"]: {
                        "network": ('xh' + 'ttp'),
                        ['xh' + 'ttp' + 'Settings']: { "host": host, "path": "/", "mode": 'auto' },
                        "security": tlsVal,
                        "sockopt": { ["dialer" + "Proxy"]: "fragment" }
                      },
                      "tag": "proxy"
                    },
                    {
                      "protocol": "freedom",
                      "settings": {
                        "fragment": {
                          "packets": "tlshello",
                          "length": window.globalFragLen || "20-30",
                          "interval": window.globalFragInt || "1-2"
                        }
                      },
                      "streamSettings": {
                        "sockopt": {
                          "domainStrategy": "UseIP",
                          "happyEyeballs": { "tryDelayMs": 250, "prioritizeIPv6": false, "interleave": 2, "maxConcurrentTry": 4 }
                        }
                      },
                      "tag": "fragment"
                    },
                    { "protocol": "dns", "settings": { "nonIPQuery": "reject" }, "tag": "dns-out" },
                    { "protocol": "freedom", "settings": { "domainStrategy": "UseIP" }, "tag": "direct" },
                    { "protocol": "blackhole", "settings": { "response": { "type": "http" } }, "tag": "block" }
                  ],
                  "routing": {
                    "domainStrategy": "IPIfNonMatch",
                    "rules": [
                      { "inboundTag": ["mixed-in"], "port": 53, "outboundTag": "dns-out", "type": "field" },
                      { "inboundTag": ["dns-in"], "outboundTag": "dns-out", "type": "field" },
                      { "inboundTag": ["remote-dns"], "outboundTag": "proxy", "type": "field" },
                      { "inboundTag": ["dns"], "outboundTag": "direct", "type": "field" },
                      { "domain": ["geosite:private"], "outboundTag": "direct", "type": "field" },
                      { "ip": ["geoip:private"], "outboundTag": "direct", "type": "field" },
                      { "network": "udp", "outboundTag": "block", "type": "field" },
                      { "network": "tcp", "outboundTag": "proxy", "type": "field" }
                    ]
                  }
                };
                
                if (tlsVal === 'tls') {
                  jsonConfig.outbounds[0]["stream" + "Settings"]["tls" + "Settings"] = {
                    "serverName": host, "fingerprint": fp, "alpn": ["http/1.1"], "allowInsecure": false
                  };
                }
                configArray.push(jsonConfig);
              });
            });

            navigator.clipboard.writeText(JSON.stringify(configArray, null, 2)).then(() => {
                showToast('کانفیگ JSON با موفقیت کپی شد!', 'success');
            }).catch(() => {
                showToast('خطا در کپی کردن کانفیگ JSON!', 'error');
            });
        }

        function showQR(encodedUsername) {
            const username = decodeURIComponent(encodedUsername);
            const link = getVlessLink(username);
            if (!link) return;
            toggleQRModal(true, link, 'QR کانفیگ VLESS');
        }

        function editUser(encodedUsername) {
            const username = decodeURIComponent(encodedUsername);
            const user = window.allUsers.find(u => u.username === username);
            if (!user) {
                showToast('کاربر یافت نشد!', 'error');
                return;
            }

            isEditMode = true;
            editingUsername = username;

            document.getElementById('modal-title').innerText = 'ویرایش کاربر: ' + username;
            document.getElementById('submit-btn').innerText = 'ذخیره تغییرات';

            const nameInput = document.getElementById('input-name');
            nameInput.value = username;
            nameInput.disabled = true;

            document.getElementById('input-limit').value = user.limit_gb || '';
            document.getElementById('input-daily').value = user.daily_limit_gb || '';
            document.getElementById('input-expiry').value = user.expiry_days || '';
            document.getElementById('input-ips').value = user.ips || '';
            
            const proxy_ip = user.proxy_ip || '';
            const selectEl = document.getElementById('input-proxy-select');
            const customEl = document.getElementById('input-proxy');
            
            let optionExists = false;
            for(let i=0; i<selectEl.options.length; i++) {
                if (selectEl.options[i].value === proxy_ip) {
                    optionExists = true; break;
                }
            }

            if (proxy_ip === '' || proxy_ip === 'none') {
                selectEl.value = '';
                customEl.style.display = 'none';
            } else if (optionExists) {
                selectEl.value = proxy_ip;
                customEl.style.display = 'none';
            } else {
                selectEl.value = 'custom';
                customEl.value = proxy_ip;
                customEl.style.display = 'block';
            }

            document.getElementById('fingerprint-select').value = user.fingerprint || 'chrome';

            const userPorts = String(user.port || '').split(',').map(p => p.trim());
            document.querySelectorAll('input[name="ports"]').forEach(cb => {
                cb.checked = userPorts.includes(cb.value);
            });

            toggleModal(true);
        }

        async function deleteUser(encodedUsername) {
            const username = decodeURIComponent(encodedUsername);
            if (confirm('آیا از حذف کاربر ' + username + ' مطمئن هستید؟')) {
                try {
                    const response = await fetch('/api/users/' + encodeURIComponent(username), { method: 'DELETE' });
                    if (response.ok) {
                        showToast('کاربر با موفقیت حذف شد.', 'success');
                        await loadUsers(true);
                    } else {
                        const errData = await response.json();
                        showToast('خطا: ' + (errData.error || 'عملیات ناموفق بود'), 'error');
                    }
                } catch (err) {
                    showToast('خطا در برقراری ارتباط با سرور', 'error');
                }
            }
        }

        function getFlagEmoji(countryCode) {
            if (!countryCode) return '🌐';
            const codePoints = countryCode.toUpperCase().split('').map(char => 127397 + char.charCodeAt(0));
            try {
                return String.fromCodePoint(...codePoints);
            } catch (e) {
                return '🌐';
            }
        }

        function renderLocationsUI(locations, activeIata) {
            const select = document.getElementById('location-select');
            locations.sort((a, b) => (a.cca2 || '').localeCompare(b.cca2 || ''));

            let html = '<option value="">🌐 پیش‌فرض (لوکیشن خودکار)</option>';
            locations.forEach(loc => {
                if (loc.iata && loc.city) {
                    const flag = getFlagEmoji(loc.cca2);
                    const isSelected = loc.iata.toUpperCase() === activeIata.toUpperCase() ? 'selected' : '';
                    html += '<option value="' + loc.iata + '" ' + isSelected + '>' + flag + ' ' + loc.city + ' (' + loc.iata + ')</option>';
                }
            });
            select.innerHTML = html;
        }

        async function loadLocations() {
            const select = document.getElementById('location-select');
            const cachedLocations = localStorage.getItem('cached_locations_list');
            const cachedActiveIata = localStorage.getItem('cached_active_iata') || '';
            let hasCachedLocs = false;
            
            if (cachedLocations) {
                try {
                    const parsedLocs = JSON.parse(cachedLocations);
                    if (Array.isArray(parsedLocs) && parsedLocs.length > 0) {
                        renderLocationsUI(parsedLocs, cachedActiveIata);
                        hasCachedLocs = true;
                    }
                } catch(e) {}
            }
            
            try {
                const statusRes = await fetch('/api/proxy-ip');
                let activeIata = '';
                if (statusRes.ok) {
                    const statusData = await statusRes.json();
                    activeIata = statusData.iata || '';
                    localStorage.setItem('cached_active_iata', activeIata);
                    
                    if(statusData.frag_len) {
                        window.globalFragLen = statusData.frag_len;
                        document.getElementById('frag-length').value = statusData.frag_len;
                    }
                    if(statusData.frag_int) {
                        window.globalFragInt = statusData.frag_int;
                        document.getElementById('frag-interval').value = statusData.frag_int;
                    }
                }

                const res = await fetch('/locations');
                if (!res.ok) throw new Error();
                const locations = await res.json();
                
                localStorage.setItem('cached_locations_list', JSON.stringify(locations));
                renderLocationsUI(locations, activeIata);
            } catch (err) {
                if (!hasCachedLocs) {
                    select.innerHTML = '<option value="">خطا در دریافت لوکیشن‌ها</option>';
                }
            }
        }

        async function saveSettings() {
            const select = document.getElementById('location-select');
            const fragLen = document.getElementById('frag-length').value || "20-30";
            const fragInt = document.getElementById('frag-interval').value || "1-2";
            const iata = select.value;
            const btn = document.getElementById('save-settings-btn');
            
            btn.disabled = true;
            btn.innerText = 'در حال ذخیره...';
            
            try {
                let resolvedIp = 'proxyip.cmliussss.net';
                if (iata) {
                    const domain = iata.toLowerCase() + '.proxyip.cmliussss.net';
                    const dnsRes = await fetch('https://cloudflare-dns.com/dns-query?name=' + domain + '&type=A', {
                        headers: { 'accept': 'application/dns-json' }
                    });
                    resolvedIp = domain;
                    if (dnsRes.ok) {
                        const dnsData = await dnsRes.json();
                        if (dnsData.Answer && dnsData.Answer.length > 0) {
                            const ips = dnsData.Answer.filter(ans => ans.type === 1).map(ans => ans.data);
                            if (ips.length > 0) {
                                resolvedIp = ips[Math.floor(Math.random() * ips.length)];
                            }
                        }
                    }
                }

                const response = await fetch('/api/proxy-ip', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ proxy_ip: resolvedIp, iata: iata ? iata.toUpperCase() : '', frag_len: fragLen, frag_int: fragInt })
                });

                if (response.ok) {
                    window.globalFragLen = fragLen;
                    window.globalFragInt = fragInt;
                    showToast('تنظیمات با موفقیت ذخیره شد.' + (iata ? ' آی‌پی: ' + resolvedIp : ''), 'success');
                    toggleSettingsModal(false);
                } else {
                    showToast('خطا در ذخیره تنظیمات', 'error');
                }
            } catch (err) {
                showToast('خطا در برقراری ارتباط با سرور', 'error');
            } finally {
                btn.disabled = false;
                btn.innerText = 'ذخیره تنظیمات';
            }
        }

        async function changeAdminPassword() {
            const currentPwd = document.getElementById('change-pwd-current').value;
            const newPwd = document.getElementById('change-pwd-new').value;
            const btn = document.getElementById('change-pwd-btn');
            
            if (!currentPwd || !newPwd) {
                showToast('وارد کردن رمز عبور فعلی و جدید الزامی است!', 'warning');
                return;
            }
            if (newPwd.length < 4) {
                showToast('رمز عبور جدید باید حداقل ۴ کاراکتر باشد!', 'warning');
                return;
            }
            
            btn.disabled = true;
            btn.innerText = 'در حال تغییر...';
            
            try {
                const response = await fetch('/api/change-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ current_password: currentPwd, new_password: newPwd })
                });
                
                const data = await response.json();
                if (response.ok && data.success) {
                    showToast('رمز عبور با موفقیت تغییر کرد.', 'success');
                    document.getElementById('change-pwd-current').value = '';
                    document.getElementById('change-pwd-new').value = '';
                    toggleSettingsModal(false);
                } else {
                    showToast('خطا: ' + (data.error || 'عملیات ناموفق بود'), 'error');
                }
            } catch (err) {
                showToast('خطا در برقراری ارتباط با سرور', 'error');
            } finally {
                btn.disabled = false;
                btn.innerText = 'تغییر رمز عبور';
            }
        }

        async function logoutAdmin() {
            if (confirm('آیا می‌خواهید از پنل خارج شوید؟')) {
                try {
                    await fetch('/api/logout', { method: 'POST' });
                } catch (err) {}
                window.location.reload();
            }
        }

        document.addEventListener('DOMContentLoaded', () => {
            renderPortCheckboxes();
            loadUsers();
            loadLocations();
            setInterval(() => loadUsers(true), 60000);
        });
    