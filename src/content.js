// 配置
// 将使用 chrome.storage.sync 存储API设置
let API_KEY = ''; // 将从设置获取
let API_URL = ''; // 将从设置获取

// 批量处理配置
const DEFAULT_BATCH_SIZE = 9; // 默认批处理大小
const MIN_BATCH_SIZE = 2; // 最小批处理大小
const MAX_BATCH_SIZE = 10; // 最大批处理大小
const BATCH_TIMEOUT = 3000; // 批处理超时时间(ms)，即使不满批次也会处理

// 全局变量
let isRunning = false;
let processedVideos = new Set();
let totalProcessed = 0;
let totalFiltered = 0;
let pendingVideos = []; // 待处理视频队列
let batchSize = DEFAULT_BATCH_SIZE; // 一次处理的视频数量
let processingBatch = false; // 是否正在处理批次
let batchTimer = null; // 批处理定时器
let isPageStabilizing = false; // 页面是否在稳定中
const PAGE_STABILIZATION_TIME = 4000; // 页面稳定等待时间(ms)，增加时间确保页面完全加载

// 获取API设置
async function getAPISettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['api_key', 'api_url'], function(result) {
      API_KEY = result.api_key || '';
      API_URL = result.api_url || '';
      resolve({ API_KEY, API_URL });
    });
  });
}

// 获取用户设置的兴趣主题
function getInterests() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['interests'], function(result) {
      let interests = [];
      if (result.interests) {
        // 处理新的数组格式和旧的字符串格式
        if (Array.isArray(result.interests)) {
          interests = result.interests;
        } else if (typeof result.interests === 'string') {
          interests = result.interests.split('\n').map(tag => tag.trim()).filter(tag => tag.length > 0);
        }
      }
      showNotification('获取的兴趣主题: ' + interests.join(', '), 'info');
      resolve(interests);
    });
  });
}

// 创建并显示通知
function showNotification(message, type = 'info') {
  // 发送系统通知
  if (type === 'success' || type === 'error') {
    chrome.runtime.sendMessage({
      action: 'showNotification',
      title: type === 'success' ? '过滤成功' : '过滤错误',
      message: message
    });
  }

  // 如果已经存在通知，则移除
  const existingNotification = document.getElementById('bilibili-filter-notification');
  if (existingNotification) {
    existingNotification.remove();
  }

  const notification = document.createElement('div');
  notification.id = 'bilibili-filter-notification';
  notification.style.position = 'fixed';
  notification.style.top = '20px';
  notification.style.right = '20px';
  notification.style.zIndex = '9999';
  notification.style.padding = '10px 20px';
  notification.style.borderRadius = '5px';
  notification.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';
  notification.style.fontSize = '14px';
  notification.style.transition = 'opacity 0.3s';

  // 根据类型设置样式
  if (type === 'success') {
    notification.style.backgroundColor = '#e8f5e9';
    notification.style.color = '#2e7d32';
    notification.style.border = '1px solid #c8e6c9';
  } else if (type === 'error') {
    notification.style.backgroundColor = '#ffebee';
    notification.style.color = '#c62828';
    notification.style.border = '1px solid #ffcdd2';
  } else {
    notification.style.backgroundColor = '#e3f2fd';
    notification.style.color = '#1565c0';
    notification.style.border = '1px solid #bbdefb';
  }

  // 添加关闭按钮
  const closeButton = document.createElement('span');
  closeButton.textContent = '×';
  closeButton.style.position = 'absolute';
  closeButton.style.top = '5px';
  closeButton.style.right = '10px';
  closeButton.style.cursor = 'pointer';
  closeButton.style.fontWeight = 'bold';
  closeButton.addEventListener('click', () => notification.remove());

  notification.textContent = message;
  notification.appendChild(closeButton);
  document.body.appendChild(notification);

  // 5秒后自动消失
  setTimeout(() => {
    notification.style.opacity = '0';
    setTimeout(() => notification.remove(), 300);
  }, 5000);
}

// 更新过滤状态显示
function updateFilterStats() {
  // 发送统计数据到后台脚本
  chrome.runtime.sendMessage({
    action: 'updateStats',
    totalProcessed: totalProcessed,
    totalFiltered: totalFiltered
  });

  const statsDiv = document.getElementById('bilibili-filter-stats');
  if (statsDiv) {
    statsDiv.textContent = `已处理: ${totalProcessed} 个视频 | 已过滤: ${totalFiltered} 个视频`;
  } else {
    const newStatsDiv = document.createElement('div');
    newStatsDiv.id = 'bilibili-filter-stats';
    newStatsDiv.style.position = 'fixed';
    newStatsDiv.style.top = '70px';
    newStatsDiv.style.right = '20px';
    newStatsDiv.style.zIndex = '9998';
    newStatsDiv.style.padding = '5px 10px';
    newStatsDiv.style.backgroundColor = 'rgba(255,255,255,0.9)';
    newStatsDiv.style.border = '1px solid #ddd';
    newStatsDiv.style.borderRadius = '3px';
    newStatsDiv.style.fontSize = '12px';
    newStatsDiv.textContent = `已处理: ${totalProcessed} 个视频 | 已过滤: ${totalFiltered} 个视频`;
    document.body.appendChild(newStatsDiv);
  }
}

// 批量分析视频内容
async function analyzeContentBatch(videoBatch, interests) {
  try {
    // 确保API设置已初始化
    await getAPISettings();
    
    // 检查API设置是否有效
    if (!API_KEY || !API_URL) {
      showNotification('请在设置中配置API密钥和API地址', 'error');
      // 返回所有视频为相关（不过滤）
      return videoBatch.map(video => ({
        ...video,
        isRelevant: true
      }));
    }
    
    const videoTitles = videoBatch.map(v => v.title).join('", "');
    showNotification(`正在批量分析 ${videoBatch.length} 个视频`, 'info');
    
    // 构建批量分析的提示
    let prompt = `请分析以下 ${videoBatch.length} 个视频标题是否与用户感兴趣的主题相关。\n\n`;
    prompt += `用户感兴趣的主题：${interests.join(', ')}\n\n`;
    prompt += '视频列表：\n';
    
    videoBatch.forEach((video, index) => {
      prompt += `${index + 1}. 标题：${video.title}\n`;
    });
    
    prompt += '\n请针对每个视频，只回复视频编号和"相关"或"不相关"的判断结果，用分号分隔，不要有其他文字。例如："1:相关;2:不相关;3:相关"';
    
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{
          role: 'system',
          content: '你是一个内容分析助手，需要判断多个视频内容是否与用户感兴趣的主题相关。请按照要求格式简洁回复。'
        }, {
          role: 'user',
          content: prompt
        }],
        temperature: 0.3
      })
    });

    const data = await response.json();
    console.log('批量API响应:', data);
    
    const resultText = data.choices[0].message.content.trim();
    showNotification('批量分析完成', 'success');
    
    // 解析结果
    const resultMap = new Map();
    const resultParts = resultText.split(';');
    
    resultParts.forEach(part => {
      const [indexStr, relevance] = part.split(':');
      // 提取数字
      const index = parseInt(indexStr.trim().replace(/\D/g, '')) - 1;
      if (index >= 0 && index < videoBatch.length) {
        resultMap.set(index, relevance.trim() === '相关');
      }
    });
    
    // 返回分析结果数组
    return videoBatch.map((video, index) => {
      const isRelevant = resultMap.has(index) ? resultMap.get(index) : true; // 默认相关
      return {
        ...video,
        isRelevant: isRelevant
      };
    });
  } catch (error) {
    console.error('批量API调用错误:', error);
    showNotification('批量API调用出错，请检查网络连接和API密钥', 'error');
    // 出错时默认所有视频都相关
    return videoBatch.map(video => ({
      ...video,
      isRelevant: true
    }));
  }
}

// 处理视频卡片
async function processVideoCard(card) {
  // 如果未运行或已处理过此视频，则跳过
  if (!isRunning) return;
  
  const cardId = card.dataset.id || Math.random().toString(36).substring(2, 15);
  if (processedVideos.has(cardId)) return;
  
  // 标记为已处理
  processedVideos.add(cardId);
  
  const titleElement = card.querySelector('.bili-video-card__info--tit');
  
  if (!titleElement) return;

  const title = titleElement.textContent.trim();
  
  // 将视频加入待处理队列
  pendingVideos.push({
    card: card,
    title: title,
    cardId: cardId
  });
  
  // 更新处理计数
  totalProcessed++;
  updateFilterStats();
  
  // 如果队列达到批处理大小，且当前没有正在处理的批次，则处理一批
  if (pendingVideos.length >= batchSize && !processingBatch) {
    await processBatch();
  }
}

// 处理一批视频
async function processBatch() {
  if (pendingVideos.length === 0 || processingBatch || isPageStabilizing) return;
  
  processingBatch = true;
  
  try {
    // 取出当前队列中的视频（最多BATCH_SIZE个）
    const currentBatch = pendingVideos.splice(0, batchSize);
    showNotification(`开始处理 ${currentBatch.length} 个视频`, 'info');
    
    // 获取兴趣主题
    const interests = await getInterests();
    
    if (interests.length === 0) {
      showNotification('没有设置兴趣主题，请先设置兴趣主题', 'error');
      processingBatch = false;
      return;
    }
    
    // 批量分析视频内容
    const analyzedVideos = await analyzeContentBatch(currentBatch, interests);
    
    // 处理每个视频的结果
    for (const video of analyzedVideos) {
      const { card, title, isRelevant } = video;
      
      showNotification(`"${title}" 与您的兴趣${isRelevant ? '相关' : '不相关'}`, isRelevant ? 'info' : 'success');
      
      if (!isRelevant) {
        // 更新过滤计数
        totalFiltered++;
        updateFilterStats();
        
        showNotification(`正在处理不感兴趣: "${title}"`, 'success');
        
        // 处理不感兴趣
        try {
          const result = await findAndTriggerNoInterestPanel(card, title);
          if (result) {
            showNotification(`成功处理不感兴趣: "${title}"`, 'success');
          } else {
            // 如果新方法失败，进行后备处理
            handleFallbackNoInterest(card, title);
          }
        } catch (error) {
          showNotification(`处理不感兴趣过程中发生错误: ${error.message}`, 'error');
          handleFallbackNoInterest(card, title);
        }
      }
    }
    
    // 如果所有视频都已处理完毕（队列为空），则自动点击"换一换"按钮
    if (pendingVideos.length === 0) {
      await clickRollButton();
    }
  } finally {
    processingBatch = false;
    
    // 如果队列中还有视频，继续处理下一批
    if (pendingVideos.length > 0 && !isPageStabilizing) {
      setTimeout(() => processBatch(), 1000); // 稍微延迟后处理下一批
    }
  }
}

// 后备的不感兴趣处理方法
function handleFallbackNoInterest(card, title) {
  showNotification(`触发不感兴趣面板失败，尝试标准方法: "${title}"`, 'error');
  
  const titleElement = card.querySelector('.bili-video-card__info--tit');
  if (!titleElement) return;
  
  // 模拟鼠标悬停在标题上
  titleElement.dispatchEvent(new MouseEvent('mouseover', {
    bubbles: true,
    cancelable: true,
    view: window
  }));

  // 等待不感兴趣按钮出现并点击
  setTimeout(() => {
    // 查找不感兴趣按钮
    const noInterestButton = card.querySelector('.bili-video-card__info--no-interest-panel--item');
    
    if (noInterestButton) {
      // 确保按钮可见
      if (ensureElementVisible(noInterestButton)) {
        showNotification('找到不感兴趣按钮，已设为可见状态', 'info');
        
        // 给按钮添加明显的样式以便识别
        noInterestButton.style.border = '2px solid red';
        noInterestButton.style.backgroundColor = 'yellow';
        
        // 延迟一下再点击，确保样式应用完成
        setTimeout(() => {
          try {
            // 首先尝试标准点击
            noInterestButton.click();
            showNotification(`成功点击不感兴趣按钮: "${title}"`, 'success');
          } catch (error) {
            showNotification('标准点击失败，尝试模拟点击事件', 'info');
            
            // 如果标准点击失败，尝试使用事件分发
            noInterestButton.dispatchEvent(new MouseEvent('click', {
              bubbles: true,
              cancelable: true,
              view: window
            }));
            
            showNotification(`模拟点击完成: "${title}"`, 'success');
          }
        }, 300);
      } else {
        showNotification(`所有方法都失败了，无法点击不感兴趣: "${title}"`, 'error');
      }
    } else {
      showNotification(`未找到任何不感兴趣按钮，无法处理: "${title}"`, 'error');
    }
  }, 800);
}

// 自动点击"换一换"按钮并等待页面稳定
async function clickRollButton() {
  // 多种方式查找换一换按钮
  
  // 1. 使用精确的选择器匹配
  let rollButton = document.querySelector('button.primary-btn.roll-btn[data-v-3581b8d4]');
  
  // 2. 如果精确匹配没找到，使用通用类选择器
  if (!rollButton) {
    rollButton = document.querySelector('button.primary-btn.roll-btn');
  }
  
  // 3. 如果仍然没找到，通过按钮文本内容查找
  if (!rollButton) {
    const allButtons = document.querySelectorAll('button');
    for (const btn of allButtons) {
      if (btn.textContent.includes('换一换')) {
        rollButton = btn;
        break;
      }
    }
  }
  
  // 4. 最后尝试查找包含SVG和"换一换"文本的元素
  if (!rollButton) {
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      if (el.querySelector('svg') && el.textContent.includes('换一换')) {
        rollButton = el;
        break;
      }
    }
  }
  
  if (rollButton) {
    showNotification(`找到"换一换"按钮，准备点击`, 'info');
    
    try {
      // 确保按钮可见并可点击
      ensureElementVisible(rollButton);
      
      // 高亮按钮以便调试
      const originalBackground = rollButton.style.backgroundColor;
      const originalBorder = rollButton.style.border;
      rollButton.style.backgroundColor = 'yellow';
      rollButton.style.border = '2px solid blue';
      
      // 记录当前页面状态，用于判断页面是否刷新
      const currentVideos = document.querySelectorAll('.bili-video-card');
      const currentVideoCount = currentVideos.length;
      const firstVideoTitle = currentVideos.length > 0 ? 
        (currentVideos[0].querySelector('.bili-video-card__info--tit')?.textContent || '') : '';
      
      // 设置页面稳定标志
      isPageStabilizing = true;
      
      // 尝试标准点击
      try {
        rollButton.click();
        showNotification('成功点击"换一换"按钮，页面刷新中', 'success');
      } catch (clickError) {
        showNotification(`标准点击失败，尝试事件分发: ${clickError.message}`, 'info');
        
        // 如果标准点击失败，尝试使用事件分发
        const rect = rollButton.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        
        const eventOptions = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: centerX,
          clientY: centerY,
          screenX: centerX,
          screenY: centerY
        };
        
        // 分发点击事件序列
        ['mousedown', 'mouseup', 'click'].forEach(eventType => {
          rollButton.dispatchEvent(new MouseEvent(eventType, eventOptions));
        });
        
        showNotification('通过事件分发完成点击', 'success');
      }
      
      // 恢复按钮原样式
      setTimeout(() => {
        try {
          rollButton.style.backgroundColor = originalBackground;
          rollButton.style.border = originalBorder;
        } catch (e) {
          // 如果按钮已经从DOM中删除，忽略错误
        }
      }, 500);
      
      // 等待页面稳定 - 使用智能等待
      showNotification(`等待页面稳定中...`, 'info');
      
      // 设置最大等待时间
      const maxWaitTime = PAGE_STABILIZATION_TIME;
      const startTime = Date.now();
      let isStable = false;
      
      // 等待页面稳定或超时
      while (!isStable && (Date.now() - startTime < maxWaitTime)) {
        // 等待一小段时间
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // 检查页面是否已经刷新
        const newVideos = document.querySelectorAll('.bili-video-card');
        const newVideoCount = newVideos.length;
        const newFirstVideoTitle = newVideos.length > 0 ? 
          (newVideos[0].querySelector('.bili-video-card__info--tit')?.textContent || '') : '';
        
        // 如果视频数量变化或第一个视频标题变化，说明页面已经刷新
        if (newVideoCount !== currentVideoCount || newFirstVideoTitle !== firstVideoTitle) {
          isStable = true;
          showNotification(`检测到页面内容已更新`, 'success');
        }
      }
      
      // 额外等待一段时间，确保页面完全加载
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // 恢复处理
      isPageStabilizing = false;
      showNotification('页面已稳定，继续处理', 'info');
      
      // 刷新后重新开始处理新加载的视频
      const videoCards = document.querySelectorAll('.bili-video-card.is-rcmd.enable-no-interest');
      
      if (videoCards.length > 0) {
        showNotification(`找到 ${videoCards.length} 个新视频卡片待处理`, 'info');
        // 清空已处理视频集合，确保新加载的视频能被处理
        processedVideos.clear();
        videoCards.forEach(processVideoCard);
      } else {
        showNotification('未找到新的视频卡片，可能需要刷新页面', 'info');
      }
      
      return true;
    } catch (error) {
      showNotification(`点击"换一换"按钮过程中发生错误: ${error.message}`, 'error');
      isPageStabilizing = false;
      return false;
    }
  } else {
    showNotification('未找到"换一换"按钮', 'info');
    return false;
  }
}

// 初始化过滤器
async function initializeFilter() {
  // 加载批处理设置
  await loadBatchSettings();
  
  // 加载API设置
  await getAPISettings();
  
  // 检查当前运行状态
  chrome.storage.sync.get(['isRunning'], function(result) {
    isRunning = result.isRunning || false;
    
    if (isRunning) {
      // 检查API设置是否有效
      if (!API_KEY || !API_URL) {
        showNotification('请在设置中配置API密钥和API地址，过滤暂时无法运行', 'error');
        isRunning = false;
        chrome.storage.sync.set({ isRunning: false }); // 更新状态
        return;
      }
      
      showNotification(`内容过滤已启动，批量处理大小: ${batchSize}`, 'info');
      startObserving();
      // 处理页面上已有的视频卡片
      const videoCards = document.querySelectorAll('.bili-video-card.is-rcmd.enable-no-interest');
      showNotification(`找到 ${videoCards.length} 个视频卡片待处理`, 'info');
      videoCards.forEach(processVideoCard);
      
      // 启动批处理定时器
      startBatchTimer();
    }
  });
  
  // 监听消息
  chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.action === 'start') {
      // 检查API设置是否有效
      if (!API_KEY || !API_URL) {
        showNotification('请在设置中配置API密钥和API地址，过滤无法启动', 'error');
        sendResponse({status: 'error', message: 'API settings not configured'});
        return true;
      }
      
      isRunning = true;
      processedVideos.clear(); // 清除已处理视频列表
      pendingVideos = []; // 清空待处理队列
      processingBatch = false; // 重置处理状态
      totalProcessed = 0;
      totalFiltered = 0;
      
      showNotification(`内容过滤已启动，批量处理大小: ${batchSize}`, 'info');
      startObserving();
      // 处理页面上已有的视频卡片
      const videoCards = document.querySelectorAll('.bili-video-card.is-rcmd.enable-no-interest');
      showNotification(`找到 ${videoCards.length} 个视频卡片待处理`, 'info');
      videoCards.forEach(processVideoCard);
      
      // 启动批处理定时器
      startBatchTimer();
    } else if (request.action === 'stop') {
      isRunning = false;
      pendingVideos = []; // 清空待处理队列
      stopObserving();
      stopBatchTimer(); // 停止批处理定时器
      showNotification('内容过滤已停止', 'info');
      
      // 移除统计显示
      const statsDiv = document.getElementById('bilibili-filter-stats');
      if (statsDiv) statsDiv.remove();
    } else if (request.action === 'setBatchSize') {
      const newSize = request.batchSize;
      if (newSize >= MIN_BATCH_SIZE && newSize <= MAX_BATCH_SIZE) {
        batchSize = newSize;
        chrome.storage.sync.set({ batchSize: batchSize });
        showNotification(`批量处理大小已更新为: ${batchSize}`, 'success');
      } else {
        showNotification(`批量处理大小必须在 ${MIN_BATCH_SIZE} 到 ${MAX_BATCH_SIZE} 之间`, 'error');
      }
    } else if (request.action === 'setAPISettings') {
      // 更新API设置
      API_KEY = request.api_key || '';
      API_URL = request.api_url || '';
      chrome.storage.sync.set({ 
        api_key: API_KEY, 
        api_url: API_URL 
      });
      showNotification('API设置已更新', 'success');
    }
    
    sendResponse({status: 'success'});
    return true; // Keep the message channel open for async responses
  });
}

// 启动批处理定时器
function startBatchTimer() {
  stopBatchTimer(); // 先停止已有的定时器
  
  // 创建新的定时器
  batchTimer = setInterval(() => {
    if (isRunning && pendingVideos.length > 0 && !processingBatch) {
      // 如果队列中有视频，且没有正在处理的批次，则开始处理
      processBatch();
    }
  }, BATCH_TIMEOUT);
}

// 停止批处理定时器
function stopBatchTimer() {
  if (batchTimer) {
    clearInterval(batchTimer);
    batchTimer = null;
  }
}

// 观察DOM变化的观察器
let observer = null;

// 开始观察
function startObserving() {
  if (observer) return;
  
  observer = new MutationObserver((mutations) => {
    if (!isRunning) return;
    
    mutations.forEach((mutation) => {
      if (mutation.addedNodes.length) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const videoCards = node.querySelectorAll('.bili-video-card.is-rcmd.enable-no-interest');
            if (videoCards.length > 0) {
              showNotification(`发现 ${videoCards.length} 个新的视频卡片`, 'info');
              videoCards.forEach(processVideoCard);
            }
          }
        });
      }
    });
  });
  
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
  
  showNotification('已开始监听新视频加载', 'info');
}

// 停止观察
function stopObserving() {
  if (observer) {
    observer.disconnect();
    observer = null;
    showNotification('已停止监听新视频加载', 'info');
  }
}

// 确保元素可见并可点击
function ensureElementVisible(element) {
  if (!element) return false;
  
  // 设置样式使元素可见
  element.style.display = 'block';
  element.style.visibility = 'visible';
  element.style.opacity = '1';
  element.style.pointerEvents = 'auto'; // 确保可以点击
  element.style.position = 'relative'; // 确保正常定位
  element.style.zIndex = '9999'; // 确保在最上层
  
  // 移除可能阻止点击的CSS类
  const classesToRemove = ['hidden', 'invisible', 'disabled'];
  classesToRemove.forEach(className => {
    if (element.classList.contains(className)) {
      element.classList.remove(className);
    }
  });
  
  // 移除disabled属性
  if (element.hasAttribute('disabled')) {
    element.removeAttribute('disabled');
  }
  
  return true;
}

// 新增的处理不感兴趣菜单点击函数
function clickNoInterestMenuItem(card) {
  return new Promise(async (resolve) => {
    try {
      // 1. 找到不感兴趣节点
      const noInterestNode = card.querySelector('.bili-video-card__info--no-interest');
      if (!noInterestNode) {
        showNotification('未找到不感兴趣节点', 'error');
        resolve(false);
        return;
      }
      
      showNotification('找到不感兴趣节点，准备激活', 'info');
      
      // 2. 确保节点可见并激活
      noInterestNode.style.display = '';
      noInterestNode.classList.add('active');
      // 移除可能阻止显示的样式
      if (noInterestNode.hasAttribute('style')) {
        if (noInterestNode.style.display === 'none') {
          noInterestNode.style.display = '';
        }
      }
      
      // 3. 模拟鼠标悬停事件
      const rect = noInterestNode.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      
      const eventOptions = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: centerX,
        clientY: centerY,
        screenX: centerX,
        screenY: centerY
      };
      
      // 分发鼠标事件序列，按照确切的顺序
      ['mouseenter', 'mouseover', 'mousemove'].forEach(eventType => {
        noInterestNode.dispatchEvent(new MouseEvent(eventType, eventOptions));
      });
      
      showNotification('已激活不感兴趣节点', 'info');
      
      // 4. 等待悬浮菜单出现
      await new Promise(r => setTimeout(r, 500));
      
      // 5. 查找弹出的菜单 - 使用与用户提供的确切结构匹配的选择器
      let popover = document.querySelector('.vui_popover.vui_popover-is-bottom-end');
      if (!popover || (popover.style.display === 'none')) {
        // 如果没找到或隐藏的，尝试查找所有vui_popover
        const allPopovers = document.querySelectorAll('.vui_popover');
        showNotification(`未找到显示的弹出菜单，找到${allPopovers.length}个弹出菜单`, 'info');
        
        // 尝试找到并显示第一个弹出菜单
        if (allPopovers.length > 0) {
          popover = allPopovers[0];
          popover.style.display = 'block';
          
          // 设置正确的位置属性，模拟实际DOM结构
          if (!popover.hasAttribute('data-popper-placement')) {
            popover.setAttribute('data-popper-placement', 'bottom-end');
          }
          
          await new Promise(r => setTimeout(r, 300));
        } else {
          showNotification('未找到任何弹出菜单', 'error');
          resolve(false);
          return;
        }
      }
      
      // 再次检查是否找到了弹出菜单
      if (!popover || popover.style.display === 'none') {
        showNotification('未能成功显示弹出菜单', 'error');
        resolve(false);
        return;
      }
      
      showNotification('成功显示弹出菜单', 'success');
      
      // 6. 找到并点击"内容不感兴趣"选项 - 使用确切的选择器
      const menuItems = popover.querySelectorAll('.bili-video-card__info--no-interest-panel--item');
      
      if (menuItems.length === 0) {
        showNotification('未找到不感兴趣菜单项', 'error');
        resolve(false);
        return;
      }
      
      // 查找"内容不感兴趣"选项
      let targetMenuItem = null;
      for (const item of menuItems) {
        const text = item.textContent.trim();
        if (text === '内容不感兴趣') {
          targetMenuItem = item;
          break;
        }
      }
      
      // 如果没找到精确匹配，就用第一项
      if (!targetMenuItem && menuItems.length > 0) {
        targetMenuItem = menuItems[0];
      }
      
      if (!targetMenuItem) {
        showNotification('未找到内容不感兴趣选项', 'error');
        resolve(false);
        return;
      }
      
      // 确保菜单项可见
      ensureElementVisible(targetMenuItem);
      
      // 高亮菜单项以便调试
      targetMenuItem.style.backgroundColor = 'yellow';
      targetMenuItem.style.border = '2px solid red';
      
      // 7. 点击菜单项
      try {
        targetMenuItem.click();
        showNotification('成功点击不感兴趣菜单项', 'success');
        
        // 添加特定的日志记录以确认成功完成操作
        console.log('成功完成"不感兴趣"操作：', targetMenuItem.textContent);
        
        resolve(true);
      } catch (error) {
        showNotification(`点击不感兴趣菜单项失败: ${error.message}`, 'error');
        
        // 尝试使用事件分发
        try {
          const clickEvent = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window
          });
          targetMenuItem.dispatchEvent(clickEvent);
          showNotification('通过事件分发成功点击不感兴趣菜单项', 'success');
          console.log('通过事件分发成功点击"不感兴趣"菜单项：', targetMenuItem.textContent);
          resolve(true);
        } catch (e) {
          showNotification(`所有点击方法都失败: ${e.message}`, 'error');
          resolve(false);
        }
      }
    } catch (error) {
      showNotification(`处理不感兴趣菜单点击过程中发生错误: ${error.message}`, 'error');
      resolve(false);
    }
  });
}

// 尝试查找并触发不感兴趣面板
function findAndTriggerNoInterestPanel(card, title) {
  return new Promise(async (resolve) => {
    try {
      showNotification(`开始处理卡片: "${title}"`, 'info');
      
      // 首先尝试新的不感兴趣菜单点击方法
      const menuResult = await clickNoInterestMenuItem(card);
      if (menuResult) {
        showNotification(`通过菜单点击成功处理: "${title}"`, 'success');
        resolve(true);
        return;
      }
      
      // 如果新方法失败，继续尝试其他方法
      showNotification('菜单点击方法未成功，尝试其他方法', 'info');
      
      // 步骤1：尝试直接通过Vue组件处理，根据提供的前端代码实现
      const vueResult = await injectVueComponentHandler(card, title);
      if (vueResult) {
        showNotification(`通过Vue组件成功处理: "${title}"`, 'success');
        resolve(true);
        return;
      }
      
      showNotification('Vue组件处理未成功，尝试常规DOM操作', 'info');
      
      // 步骤2：尝试查找"更多"按钮并点击
      const moreButton = card.querySelector('.bili-video-card__info--more');
      if (moreButton) {
        showNotification('找到"更多"按钮，尝试点击', 'info');
        
        // 确保按钮可见
        ensureElementVisible(moreButton);
        moreButton.style.backgroundColor = 'yellow';
        moreButton.style.border = '2px solid blue';
        
        try {
          // 尝试点击"更多"按钮
          moreButton.click();
          
          // 等待不感兴趣面板出现
          await new Promise(r => setTimeout(r, 800));
          
          // 查找不感兴趣面板项
          const panelItems = document.querySelectorAll('.bili-video-card__info--no-interest-panel--item');
          
          if (panelItems.length > 0) {
            showNotification('找到不感兴趣面板项，尝试点击', 'success');
            
            // 确保面板项可见
            const panelItem = panelItems[0];
            ensureElementVisible(panelItem);
            
            // 高亮面板项
            panelItem.style.backgroundColor = 'lime';
            panelItem.style.border = '2px solid red';
            
            try {
              // 点击面板项
              panelItem.click();
              showNotification('成功点击不感兴趣面板项', 'success');
              resolve(true);
              return;
            } catch (e) {
              showNotification(`点击面板项失败: ${e.message}`, 'error');
            }
          } else {
            showNotification('未找到不感兴趣面板项', 'error');
          }
        } catch (e) {
          showNotification(`点击"更多"按钮失败: ${e.message}`, 'error');
        }
      }
      
      // 步骤3：尝试直接模拟不感兴趣节点的悬停和点击
      showNotification('尝试找到不感兴趣节点并直接操作', 'info');
      
      // 查找可能的不感兴趣节点
      const noInterestNode = card.querySelector('.bili-video-card__info--no-interest');
      
      if (noInterestNode) {
        showNotification('找到不感兴趣节点，尝试模拟悬停', 'success');
        
        // 确保节点可见
        ensureElementVisible(noInterestNode);
        
        // 模拟悬停
        noInterestNode.dispatchEvent(new MouseEvent('mouseover', {
          bubbles: true,
          cancelable: true,
          view: window
        }));
        
        // 等待面板出现
        await new Promise(r => setTimeout(r, 800));
        
        // 再次查找面板项
        const panelItem = card.querySelector('.bili-video-card__info--no-interest-panel--item');
        
        if (panelItem) {
          showNotification('找到面板项，尝试点击', 'success');
          
          // 确保面板项可见
          ensureElementVisible(panelItem);
          
          try {
            // 点击面板项
            panelItem.click();
            showNotification('成功点击面板项', 'success');
            resolve(true);
            return;
          } catch (e) {
            showNotification(`点击面板项失败: ${e.message}`, 'error');
          }
        }
      }
      
      // 步骤4：最后手段 - 使用模拟悬停
      showNotification('常规方法都失败了，尝试模拟完整的鼠标悬停序列', 'info');
      
      // 使用增强版悬停模拟
      const titleElement = card.querySelector('.bili-video-card__info--tit');
      if (titleElement) {
        const hoverState = simulateHover(titleElement);
        
        // 等待面板出现
        await new Promise(r => setTimeout(r, 1000));
        
        // 查找面板项
        const finalPanelItem = card.querySelector('.bili-video-card__info--no-interest-panel--item');
        
        if (finalPanelItem) {
          showNotification('找到最终面板项，尝试点击', 'success');
          
          ensureElementVisible(finalPanelItem);
          
          try {
            finalPanelItem.click();
            showNotification('成功点击最终面板项', 'success');
            
            // 清理悬停状态
            if (hoverState && hoverState.cleanup) {
              hoverState.cleanup();
            }
            
            resolve(true);
            return;
          } catch (e) {
            showNotification(`点击最终面板项失败: ${e.message}`, 'error');
            
            // 清理悬停状态
            if (hoverState && hoverState.cleanup) {
              hoverState.cleanup();
            }
          }
        } else {
          showNotification('未找到最终面板项', 'error');
          
          // 清理悬停状态
          if (hoverState && hoverState.cleanup) {
            hoverState.cleanup();
          }
        }
      }
      
      // 如果所有方法都失败，尝试直接标记卡片为已过滤
      showNotification('所有方法都失败，尝试直接标记卡片为已过滤', 'info');
      
      const videoCard = card.closest('.bili-video-card');
      if (videoCard) {
        videoCard.style.opacity = '0.5';
        videoCard.style.pointerEvents = 'none';
        videoCard.dataset.filtered = 'true';
        showNotification('已标记卡片为已过滤', 'success');
        resolve(true);
      } else {
        showNotification('无法标记卡片为已过滤', 'error');
        resolve(false);
      }
    } catch (error) {
      showNotification(`处理过程中发生错误: ${error.message}`, 'error');
      
      // 错误恢复：尝试标记卡片为已过滤
      try {
        const videoCard = card.closest('.bili-video-card');
        if (videoCard) {
          videoCard.style.opacity = '0.5';
          videoCard.style.pointerEvents = 'none';
          videoCard.dataset.filtered = 'true';
          showNotification('发生错误后已标记卡片为已过滤', 'success');
          resolve(true);
        } else {
          resolve(false);
        }
      } catch (e) {
        resolve(false);
      }
    }
  });
}

// 注入识别前端框架的脚本
function injectFrameworkAwareScript(card, triggerElement, title) {
  return new Promise((resolve) => {
    try {
      // 为元素添加唯一ID
      const uniqueId = 'vue-trigger-' + Math.random().toString(36).substring(2, 15);
      triggerElement.id = uniqueId;
      
      const cardId = card.dataset.id || '';
      
      // 创建脚本元素
      const script = document.createElement('script');
      script.textContent = `
        (function() {
          try {
            console.log('开始执行框架感知脚本');
            
            // 找到目标元素
            const triggerElement = document.getElementById('${uniqueId}');
            if (!triggerElement) {
              console.error('未找到触发元素');
              return;
            }
            
            // 找到卡片元素
            const card = triggerElement.closest('.bili-video-card');
            if (!card) {
              console.error('未找到卡片元素');
              return;
            }
            
            // 函数：遍历并查找Vue/React实例
            function findInstance(element) {
              // 尝试查找Vue实例
              for (const key in element) {
                if (key.startsWith('__vue') || key.startsWith('_vue') || key === 'vue') {
                  return { type: 'vue', instance: element[key] };
                }
                if (key.startsWith('__react') || key.startsWith('_react') || key === 'react' || key === '_reactFiber') {
                  return { type: 'react', instance: element[key] };
                }
              }
              
              return null;
            }
            
            // 函数：递归查找包含特定方法的对象
            function findMethodInObject(obj, methodName, visited = new Set()) {
              if (!obj || typeof obj !== 'object' || visited.has(obj)) return null;
              visited.add(obj);
              
              // 直接检查当前对象
              if (typeof obj[methodName] === 'function') {
                return { object: obj, method: obj[methodName] };
              }
              
              // 检查原型链
              if (Object.getPrototypeOf(obj) && typeof Object.getPrototypeOf(obj)[methodName] === 'function') {
                return { 
                  object: Object.getPrototypeOf(obj), 
                  method: Object.getPrototypeOf(obj)[methodName] 
                };
              }
              
              // 递归检查所有属性
              for (const key in obj) {
                try {
                  if (typeof obj[key] === 'object' && obj[key] !== null) {
                    const result = findMethodInObject(obj[key], methodName, visited);
                    if (result) return result;
                  }
                } catch (e) {
                  // 忽略访问错误
                }
              }
              
              return null;
            }
            
            // 尝试查找Vue实例
            const instance = findInstance(card) || findInstance(triggerElement);
            console.log('找到实例:', instance);
            
            if (instance) {
              console.log('找到框架实例类型:', instance.type);
              
              // 查找clickNoInterest方法
              const methodFinder = findMethodInObject(instance.instance, 'clickNoInterest');
              
              if (methodFinder) {
                console.log('找到clickNoInterest方法');
                try {
                  // 尝试调用方法
                  methodFinder.method.call(methodFinder.object, {});
                  console.log('成功调用clickNoInterest方法');
                  card.dataset.vueClickSuccess = 'true';
                  return;
                } catch (e) {
                  console.error('调用方法失败:', e);
                }
              }
              
              // 查找其他可能的处理函数
              const possibleMethodNames = [
                'clickNoInterest',
                'dislike',
                'handleDislike',
                'handleNoInterest',
                'onNoInterest',
                'onDislike'
              ];
              
              for (const methodName of possibleMethodNames) {
                const finder = findMethodInObject(instance.instance, methodName);
                if (finder) {
                  console.log('找到方法:', methodName);
                  try {
                    finder.method.call(finder.object, {});
                    console.log('成功调用方法:', methodName);
                    card.dataset.vueClickSuccess = 'true';
                    return;
                  } catch (e) {
                    console.error('调用方法失败:', e);
                  }
                }
              }
            }
            
            // 直接查找不感兴趣面板并点击
            console.log('尝试直接查找和点击不感兴趣面板元素');
            const noInterestPanel = document.querySelector('.bili-video-card__info--no-interest-panel');
            
            if (noInterestPanel) {
              console.log('找到不感兴趣面板');
              const items = noInterestPanel.querySelectorAll('.bili-video-card__info--no-interest-panel--item');
              
              if (items.length > 0) {
                console.log('找到面板项，进行点击');
                items[0].click();
                card.dataset.vueClickSuccess = 'true';
              }
            } else {
              // 尝试创建并点击不感兴趣按钮
              console.log('未找到面板，尝试创建');
              
              // 查找可能的更多按钮并点击
              const moreButton = card.querySelector('.bili-video-card__info--more');
              if (moreButton) {
                console.log('找到更多按钮，点击');
                moreButton.click();
                
                // 等待面板出现
                setTimeout(() => {
                  const newPanel = document.querySelector('.bili-video-card__info--no-interest-panel');
                  if (newPanel) {
                    const newItems = newPanel.querySelectorAll('.bili-video-card__info--no-interest-panel--item');
                    if (newItems.length > 0) {
                      console.log('点击面板中的项');
                      newItems[0].click();
                      card.dataset.vueClickSuccess = 'true';
                    }
                  }
                }, 500);
              }
            }
          } catch (e) {
            console.error('框架感知脚本执行错误:', e);
          }
        })();
      `;
      
      // 添加到页面
      document.body.appendChild(script);
      
      // 给脚本执行时间
      setTimeout(() => {
        // 清理脚本
        if (script.parentNode) {
          script.parentNode.removeChild(script);
        }
        
        // 检查是否成功
        const videoCard = card.closest('.bili-video-card');
        if (videoCard && videoCard.dataset.vueClickSuccess === 'true') {
          showNotification('成功通过框架事件系统处理', 'success');
          resolve(true);
        } else {
          showNotification('框架事件处理未成功', 'info');
          resolve(false);
        }
      }, 1500);  // 给足够的时间让框架事件完成
    } catch (error) {
      showNotification(`注入框架感知脚本失败: ${error.message}`, 'error');
      resolve(false);
    }
  });
}

// 模拟完整的鼠标交互序列
async function simulateCompleteMouseInteraction(element, card) {
  if (!element) return false;
  
  showNotification('模拟完整的鼠标交互序列', 'info');
  
  // 1. 首先尝试找到"更多"按钮
  const moreButton = card.querySelector('.bili-video-card__info--more');
  if (moreButton) {
    showNotification('找到更多按钮，尝试点击', 'info');
    
    // 确保按钮可见
    ensureElementVisible(moreButton);
    
    // 高亮按钮
    moreButton.style.backgroundColor = 'yellow';
    moreButton.style.border = '2px solid blue';
    
    // 点击
    try {
      moreButton.click();
      showNotification('成功点击更多按钮', 'success');
      
      // 等待菜单出现
      await new Promise(resolve => setTimeout(resolve, 800));
      
      // 尝试找到不感兴趣选项
      const menuItems = document.querySelectorAll('.v-popover-content .v-popover-item, .popup-item, [class*="menu-item"]');
      
      for (const item of menuItems) {
        const text = item.textContent || item.innerText || '';
        if (text.includes('不感兴趣')) {
          showNotification(`找到菜单项: ${text}`, 'success');
          
          // 确保可见
          ensureElementVisible(item);
          
          // 高亮
          item.style.backgroundColor = 'lime';
          item.style.border = '2px solid red';
          
          // 点击
          try {
            item.click();
            showNotification('成功点击不感兴趣菜单项', 'success');
            return true;
          } catch (e) {
            showNotification(`点击菜单项失败: ${e.message}`, 'error');
          }
        }
      }
      
      showNotification('未在菜单中找到不感兴趣选项', 'info');
    } catch (e) {
      showNotification(`点击更多按钮失败: ${e.message}`, 'error');
    }
  }
  
  // 2. 如果没有找到"更多"按钮或点击失败，尝试模拟鼠标悬停
  return simulateHoverAndFindPanel(element, card);
}

// 模拟悬停并查找面板
async function simulateHoverAndFindPanel(element, card) {
  // 计算元素的位置
  const rect = element.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  
  // 模拟鼠标移动事件序列
  const eventOptions = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: centerX,
    clientY: centerY,
    screenX: centerX,
    screenY: centerY
  };
  
  // 创建并分发所有事件
  [
    'mouseenter', 'mouseover', 'mousemove',
    'focus', 'pointerover', 'pointerenter'
  ].forEach(eventType => {
    const event = new MouseEvent(eventType, eventOptions);
    element.dispatchEvent(event);
  });
  
  showNotification('已分发鼠标事件', 'info');
  
  // 等待面板出现
  await new Promise(resolve => setTimeout(resolve, 800));
  
  // 查找面板
  const panels = document.querySelectorAll(
    '.bili-video-card__info--no-interest-panel, ' + 
    '[class*="operation-panel"], ' + 
    '[class*="options-panel"], ' + 
    '[class*="menu-panel"]'
  );
  
  if (panels.length > 0) {
    showNotification(`找到${panels.length}个可能的面板`, 'success');
    
    // 检查每个面板中的选项
    for (const panel of panels) {
      const items = panel.querySelectorAll('*');
      
      for (const item of items) {
        const text = item.textContent || item.innerText || '';
        if (text.includes('不感兴趣')) {
          showNotification(`找到面板选项: ${text}`, 'success');
          
          // 确保可见
          ensureElementVisible(item);
          
          // 高亮
          item.style.backgroundColor = 'lime';
          item.style.border = '2px solid red';
          
          // 点击
          try {
            item.click();
            showNotification('成功点击面板选项', 'success');
            return true;
          } catch (e) {
            showNotification(`点击面板选项失败: ${e.message}`, 'error');
            
            try {
              // 尝试事件分发
              const clickEvent = new MouseEvent('click', eventOptions);
              item.dispatchEvent(clickEvent);
              showNotification('事件分发成功', 'success');
              return true;
            } catch (err) {
              showNotification('事件分发失败', 'error');
            }
          }
        }
      }
    }
  }
  
  showNotification('未找到面板或面板中无不感兴趣选项', 'info');
  return false;
}

// 尝试直接调用元素的点击处理函数
function invokeClickHandler(element, handlerName) {
  return new Promise((resolve) => {
    const uniqueId = 'handler-target-' + Math.random().toString(36).substring(2, 15);
    element.id = uniqueId;
    
    const script = document.createElement('script');
    script.textContent = `
      (function() {
        try {
          const element = document.getElementById('${uniqueId}');
          if (!element) return;
          
          // 查找可能的处理函数
          const possibleNames = ['${handlerName}', 'onClick', 'handleClick', 'click', 'onPress'];
          
          // 查找Vue实例
          let vueInstance = null;
          for (const key in element) {
            if (key.startsWith('__vue') || key.startsWith('_vue')) {
              vueInstance = element[key];
              break;
            }
          }
          
          if (vueInstance) {
            console.log('找到Vue实例');
            
            // 在Vue实例中查找方法
            let found = false;
            for (const name of possibleNames) {
              if (typeof vueInstance[name] === 'function') {
                console.log('调用方法:', name);
                vueInstance[name]();
                element.dataset.handlerSuccess = 'true';
                found = true;
                break;
              }
            }
            
            if (!found) {
              // 递归查找
              function findMethod(obj, visited = new Set()) {
                if (!obj || typeof obj !== 'object' || visited.has(obj)) return null;
                visited.add(obj);
                
                for (const name of possibleNames) {
                  if (typeof obj[name] === 'function') {
                    return { name, method: obj[name], context: obj };
                  }
                }
                
                for (const key in obj) {
                  try {
                    if (typeof obj[key] === 'object' && obj[key] !== null) {
                      const result = findMethod(obj[key], visited);
                      if (result) return result;
                    }
                  } catch (e) {}
                }
                
                return null;
              }
              
              const result = findMethod(vueInstance);
              if (result) {
                console.log('找到方法:', result.name);
                result.method.call(result.context);
                element.dataset.handlerSuccess = 'true';
              }
            }
          }
        } catch (e) {
          console.error('调用处理函数失败:', e);
        }
      })();
    `;
    
    document.body.appendChild(script);
    
    setTimeout(() => {
      if (script.parentNode) {
        script.parentNode.removeChild(script);
      }
      
      if (element.dataset.handlerSuccess === 'true') {
        showNotification('成功调用处理函数', 'success');
        resolve(true);
      } else {
        resolve(false);
      }
    }, 800);
  });
}

// 注入Vue组件事件处理函数
function injectVueComponentHandler(card, title) {
  return new Promise(resolve => {
    try {
      showNotification('尝试通过Vue组件直接触发不感兴趣按钮', 'info');
      
      // 创建脚本元素
      const script = document.createElement('script');
      script.textContent = `
        (function() {
          try {
            console.log('开始执行Vue组件事件处理');
            
            // 找到卡片
            const cards = document.querySelectorAll('.bili-video-card');
            let targetCard = null;
            
            // 通过标题匹配查找具体的卡片
            const title = "${title.replace(/"/g, '\\"')}";
            for (const card of cards) {
              const titleEl = card.querySelector('.bili-video-card__info--tit');
              if (titleEl && titleEl.textContent.trim() === title) {
                targetCard = card;
                break;
              }
            }
            
            if (!targetCard) {
              console.log('未找到匹配标题的卡片');
              return;
            }
            
            console.log('找到目标卡片:', targetCard);
            
            // 查找所有可能的Vue实例
            function findVueInstance(element) {
              for (const key in element) {
                if (key.startsWith('__vue')) {
                  return element[key];
                }
              }
              return null;
            }
            
            // 递归查找包含clickNoInterest方法的对象
            function findMethodInVue(obj, visited = new Set()) {
              if (!obj || typeof obj !== 'object' || visited.has(obj)) return null;
              visited.add(obj);
              
              if (typeof obj.clickNoInterest === 'function') {
                return { object: obj, method: obj.clickNoInterest };
              }
              
              for (const key in obj) {
                try {
                  if (typeof obj[key] === 'object' && obj[key] !== null) {
                    const result = findMethodInVue(obj[key], visited);
                    if (result) return result;
                  }
                } catch (e) {}
              }
              
              return null;
            }
            
            // 1. 尝试在卡片元素上找Vue实例
            let vueInstance = findVueInstance(targetCard);
            
            // 2. 如果卡片上没找到，尝试在子元素上找
            if (!vueInstance) {
              const allElements = targetCard.querySelectorAll('*');
              for (const el of allElements) {
                vueInstance = findVueInstance(el);
                if (vueInstance) break;
              }
            }
            
            // 3. 如果找到了Vue实例，查找clickNoInterest方法
            if (vueInstance) {
              console.log('找到Vue实例');
              
              const methodInfo = findMethodInVue(vueInstance);
              
              if (methodInfo) {
                console.log('找到clickNoInterest方法，调用中...');
                methodInfo.method.call(methodInfo.object);
                targetCard.dataset.vueHandled = 'true';
                console.log('调用成功');
              } else {
                console.log('未找到clickNoInterest方法');
                
                // 4. 尝试直接找到不感兴趣面板
                const moreBtn = targetCard.querySelector('.bili-video-card__info--more');
                if (moreBtn) {
                  console.log('找到更多按钮，点击');
                  moreBtn.click();
                  
                  // 等待面板出现
                  setTimeout(() => {
                    const panel = document.querySelector('.bili-video-card__info--no-interest-panel');
                    if (panel) {
                      const items = panel.querySelectorAll('.bili-video-card__info--no-interest-panel--item');
                      if (items.length > 0) {
                        console.log('找到不感兴趣选项，点击');
                        items[0].click();
                        targetCard.dataset.vueHandled = 'true';
                      }
                    }
                  }, 300);
                }
              }
            } else {
              console.log('未找到Vue实例');
            }
          } catch (e) {
            console.error('Vue组件处理失败:', e);
          }
        })();
      `;
      
      // 将脚本添加到页面
      document.body.appendChild(script);
      
      // 等待脚本执行
      setTimeout(() => {
        // 清理脚本
        if (script.parentNode) {
          script.parentNode.removeChild(script);
        }
        
        // 检查是否成功处理
        const videoCard = card.closest('.bili-video-card');
        if (videoCard && videoCard.dataset.vueHandled === 'true') {
          showNotification('成功通过Vue组件处理', 'success');
          resolve(true);
        } else {
          showNotification('Vue组件处理未成功', 'info');
          resolve(false);
        }
      }, 1000);
    } catch (error) {
      showNotification(`Vue组件处理出错: ${error.message}`, 'error');
      resolve(false);
    }
  });
}

// 分析单个视频内容（作为后备方法）
async function analyzeContent(title, interests) {
  try {
    // 确保API设置已初始化
    await getAPISettings();
    
    // 检查API设置是否有效
    if (!API_KEY || !API_URL) {
      showNotification('请在设置中配置API密钥和API地址', 'error');
      return true; // 返回视频为相关（不过滤）
    }
    
    showNotification(`单独分析视频: "${title}"`, 'info');
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{
          role: 'system',
          content: '你是一个内容分析助手，需要判断视频内容是否与用户感兴趣的主题相关。'
        }, {
          role: 'user',
          content: `视频标题：${title}\n用户感兴趣的主题：${interests.join(', ')}\n\n请分析这个视频是否与用户感兴趣的主题相关。如果相关，返回"相关"；如果不相关，返回"不相关"。`
        }],
        temperature: 0.3
      })
    });

    const data = await response.json();
    console.log('单独API响应:', data);
    const isRelevant = data.choices[0].message.content.trim() === '相关';
    showNotification(`分析结果: "${title}" 与您的兴趣${isRelevant ? '相关' : '不相关'}`, isRelevant ? 'info' : 'success');
    return isRelevant;
  } catch (error) {
    console.error('API调用错误:', error);
    showNotification('API调用出错，请检查网络连接和API密钥', 'error');
    return true; // 发生错误时默认不点击不感兴趣
  }
}

// 加载批处理设置
function loadBatchSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['batchSize'], function(result) {
      if (result.batchSize && 
          result.batchSize >= MIN_BATCH_SIZE && 
          result.batchSize <= MAX_BATCH_SIZE) {
        batchSize = result.batchSize;
      } else {
        batchSize = DEFAULT_BATCH_SIZE;
      }
      resolve(batchSize);
    });
  });
}

// 初始化
initializeFilter(); 